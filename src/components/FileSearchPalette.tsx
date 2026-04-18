import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatchFile } from "../lib/fuzzyMatch";
import { fs as fsApi } from "../lib/ipc";
import type { FileEntry } from "../lib/types";
import { useExplorerStore } from "../stores/explorerStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

const MAX_VISIBLE_RESULTS = 200;

const fileCache = new Map<string, FileEntry[]>();

function sortFileEntries(entries: FileEntry[]): FileEntry[] {
	return [...entries].sort((a, b) => {
		const byName = a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
		});
		if (byName !== 0) return byName;
		return a.relativePath.localeCompare(b.relativePath, undefined, {
			sensitivity: "base",
		});
	});
}

export function invalidateFileSearchCache(workspaceId?: string) {
	if (workspaceId) fileCache.delete(workspaceId);
	else fileCache.clear();
}

interface Props {
	open: boolean;
	onClose: () => void;
}

export function FileSearchPalette({ open: isOpen, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [files, setFiles] = useState<FileEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const workspace = useMemo(
		() => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
		[workspaces, activeWorkspaceId],
	);

	useEffect(() => {
		if (!isOpen) return;
		setQuery("");
		setSelectedIndex(0);
		setError(null);
		setTimeout(() => inputRef.current?.focus(), 50);

		if (!workspace) {
			setFiles([]);
			return;
		}

		const cached = fileCache.get(workspace.id);
		if (cached) {
			setFiles(cached);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setFiles([]);
		fsApi
			.listFiles(workspace.rootFolder)
			.then((result) => {
				if (cancelled) return;
				const sorted = sortFileEntries(result);
				fileCache.set(workspace.id, sorted);
				setFiles(sorted);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, workspace]);

	const filtered = useMemo(() => {
		if (!query) return files.slice(0, MAX_VISIBLE_RESULTS);
		return files
			.map((f) => ({ file: f, score: fuzzyMatchFile(query, f.relativePath) }))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, MAX_VISIBLE_RESULTS)
			.map(({ file }) => file);
	}, [files, query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when query changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	useEffect(() => {
		if (!listRef.current) return;
		const selected = listRef.current.children[selectedIndex] as
			| HTMLElement
			| undefined;
		selected?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const openSelection = useCallback(
		(entry: FileEntry) => {
			if (!workspace) return;
			useExplorerStore
				.getState()
				.openFile(workspace.id, entry.path)
				.catch((err) => {
					console.error("Failed to open file:", err);
				});
			onClose();
		},
		[workspace, onClose],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter" && filtered[selectedIndex]) {
				e.preventDefault();
				openSelection(filtered[selectedIndex]);
			} else if (e.key === "Escape") {
				onClose();
			}
		},
		[filtered, selectedIndex, onClose, openSelection],
	);

	if (!isOpen) return null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-start justify-center"
			style={{ paddingTop: 80, backgroundColor: "rgba(0,0,0,0.5)" }}
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			<div
				role="dialog"
				className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
				style={{
					width: 520,
					maxHeight: 420,
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				<div
					className="p-3"
					style={{ borderBottom: "1px solid var(--border)" }}
				>
					<input
						ref={inputRef}
						type="text"
						placeholder={
							workspace ? "Search files by name..." : "No workspace selected"
						}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						disabled={!workspace}
						className="w-full bg-transparent outline-none"
						style={{
							color: "var(--fg-primary)",
							fontSize: 15,
							padding: "6px 4px",
						}}
					/>
				</div>
				<div ref={listRef} className="flex-1 overflow-y-auto py-2">
					{loading && (
						<div
							className="px-4 py-6 text-center"
							style={{ color: "var(--fg-secondary)", fontSize: 14 }}
						>
							Indexing files…
						</div>
					)}
					{error && !loading && (
						<div
							className="px-4 py-6 text-center"
							style={{ color: "var(--fg-secondary)", fontSize: 14 }}
						>
							{error}
						</div>
					)}
					{!loading && !error && filtered.length === 0 && (
						<div
							className="px-4 py-6 text-center"
							style={{ color: "var(--fg-secondary)", fontSize: 14 }}
						>
							{files.length === 0 ? "No files found" : "No matches"}
						</div>
					)}
					{!loading &&
						!error &&
						filtered.map((entry, i) => {
							const slash = entry.relativePath.lastIndexOf("/");
							const dir =
								slash === -1 ? "" : entry.relativePath.slice(0, slash);
							const isSelected = i === selectedIndex;
							return (
								<button
									key={entry.path}
									type="button"
									onClick={() => openSelection(entry)}
									onMouseEnter={() => setSelectedIndex(i)}
									className="w-full text-left flex items-baseline rounded-lg mx-1.5 transition-colors gap-2"
									style={{
										padding: "8px 12px",
										fontSize: 14,
										width: "calc(100% - 12px)",
										color: isSelected
											? "var(--bg-primary)"
											: "var(--fg-primary)",
										backgroundColor: isSelected
											? "var(--accent)"
											: "transparent",
									}}
								>
									<span style={{ fontWeight: 500 }}>{entry.name}</span>
									{dir && (
										<span
											className="truncate"
											style={{
												fontSize: 12,
												opacity: isSelected ? 0.8 : 0.6,
											}}
										>
											{dir}
										</span>
									)}
								</button>
							);
						})}
				</div>
			</div>
		</div>
	);
}
