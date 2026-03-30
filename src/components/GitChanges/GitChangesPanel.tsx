import { useEffect, useState } from "react";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { GitChangesFileList } from "./GitChangesFileList";
import { GitChangesResizer } from "./GitChangesResizer";
import { BranchSelector } from "./BranchSelector";
import { GitCompare, RefreshCw, PanelRight } from "../Icons";
import { git, fs } from "../../lib/ipc";
import type { GitChangedFile } from "../../lib/types";

interface Props {
	titlebarHeight: number;
}

export function GitChangesPanel({ titlebarHeight }: Props) {
	const panelOpen = useGitChangesStore((s) => s.panelOpen);
	const togglePanel = useGitChangesStore((s) => s.togglePanel);
	const changedFiles = useGitChangesStore((s) => s.changedFiles);
	const baseBranch = useGitChangesStore((s) => s.baseBranch);
	const currentBranch = useGitChangesStore((s) => s.currentBranch);
	const loading = useGitChangesStore((s) => s.loading);
	const error = useGitChangesStore((s) => s.error);
	const fetchChanges = useGitChangesStore((s) => s.fetchChanges);
	const clear = useGitChangesStore((s) => s.clear);

	const gitPanelWidth = useSettingsStore((s) => s.gitPanelWidth);

	const [selectedFile, setSelectedFile] = useState<GitChangedFile | null>(null);

	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const sessions = useSessionStore((s) => s.sessions);
	const activeSession = sessions.find((s) => s.id === activeSessionId);
	const cwd = activeSession?.rootFolder ?? null;
	const sessionBaseBranch = activeSession?.baseBranch ?? null;

	// Fetch changes when session changes or panel opens
	useEffect(() => {
		if (!panelOpen || !cwd) {
			clear();
			return;
		}
		fetchChanges(cwd, sessionBaseBranch);
	}, [panelOpen, cwd, sessionBaseBranch, fetchChanges, clear]);

	// Re-fetch on file system or git changes
	useEffect(() => {
		if (!panelOpen || !cwd) return;
		let unlistenFs: (() => void) | null = null;
		let unlistenGit: (() => void) | null = null;
		let cancelled = false;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		const debouncedFetch = () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				fetchChanges(cwd, sessionBaseBranch);
			}, 1000);
		};

		fs.onFsChange(cwd, debouncedFetch).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlistenFs = fn;
			}
		});

		fs.onGitChange(cwd, debouncedFetch).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlistenGit = fn;
			}
		});

		return () => {
			cancelled = true;
			unlistenFs?.();
			unlistenGit?.();
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	}, [panelOpen, cwd, sessionBaseBranch, fetchChanges]);

	async function handleSelectFile(file: GitChangedFile) {
		if (!cwd || !activeSessionId) return;
		setSelectedFile(file);
		try {
			const diff = await git.fileDiff(cwd, file.path, file.section, sessionBaseBranch);
			useExplorerStore.getState().openDiff(activeSessionId, file.path, diff.original, diff.modified);
		} catch {
			// Failed to load diff
		}
	}

	function handleRefresh() {
		if (cwd) fetchChanges(cwd, sessionBaseBranch);
	}

	// Collapsed state — show a thin strip
	if (!panelOpen) {
		return (
			<div
				className="flex flex-col items-center flex-shrink-0"
				style={{
					width: 44,
					paddingTop: titlebarHeight + 8,
					backgroundColor: "var(--bg-secondary)",
					borderLeft: "1px solid var(--border)",
				}}
			>
				<button
					type="button"
					onClick={togglePanel}
					className="flex items-center justify-center rounded-md w-8 h-8 transition-colors"
					style={{ color: "var(--fg-secondary)" }}
					onMouseEnter={(e) => {
						e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
						e.currentTarget.style.color = "var(--accent)";
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.backgroundColor = "transparent";
						e.currentTarget.style.color = "var(--fg-secondary)";
					}}
					title="Open Git Changes (Cmd+Shift+G)"
				>
					<GitCompare size={16} />
				</button>
			</div>
		);
	}

	const totalAdditions = changedFiles.reduce((s, f) => s + f.additions, 0);
	const totalDeletions = changedFiles.reduce((s, f) => s + f.deletions, 0);

	return (
		<>
			<GitChangesResizer />
			<div
				className="flex flex-col flex-shrink-0 h-full"
				style={{
					width: gitPanelWidth,
					backgroundColor: "var(--bg-secondary)",
					borderLeft: "1px solid var(--border)",
					paddingTop: titlebarHeight,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center gap-2 py-2 flex-shrink-0"
					style={{ borderBottom: "1px solid var(--border)", paddingLeft: 12, paddingRight: 12 }}
				>
					<GitCompare size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
					<span
						className="font-medium truncate"
						style={{ fontSize: 12, color: "var(--fg-primary)" }}
					>
						Changes
					</span>

					{cwd && activeSessionId && (
						<BranchSelector cwd={cwd} sessionId={activeSessionId} />
					)}

					<div className="flex-1" />

					{/* Stats */}
					{changedFiles.length > 0 && (
						<span className="flex items-center gap-1 flex-shrink-0" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
							<span style={{ color: "var(--fg-secondary)" }}>{changedFiles.length}F</span>
							{totalAdditions > 0 && <span style={{ color: "var(--success)" }}>+{totalAdditions}</span>}
							{totalDeletions > 0 && <span style={{ color: "var(--error)" }}>-{totalDeletions}</span>}
						</span>
					)}

					<button
						type="button"
						onClick={handleRefresh}
						className="flex items-center justify-center rounded w-6 h-6 transition-colors flex-shrink-0"
						style={{ color: "var(--fg-secondary)" }}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
							e.currentTarget.style.color = "var(--fg-primary)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = "transparent";
							e.currentTarget.style.color = "var(--fg-secondary)";
						}}
						title="Refresh"
					>
						<RefreshCw size={12} />
					</button>
					<button
						type="button"
						onClick={togglePanel}
						className="flex items-center justify-center rounded w-6 h-6 transition-colors flex-shrink-0"
						style={{ color: "var(--fg-secondary)" }}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
							e.currentTarget.style.color = "var(--fg-primary)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = "transparent";
							e.currentTarget.style.color = "var(--fg-secondary)";
						}}
						title="Close panel"
					>
						<PanelRight size={12} />
					</button>
				</div>

				{/* Current branch indicator */}
				{currentBranch && (
					<div
						className="flex items-center gap-1.5 py-1.5 flex-shrink-0"
						style={{
							borderBottom: "1px solid var(--border)",
							backgroundColor: "color-mix(in srgb, var(--bg-tertiary) 30%, transparent)",
							paddingLeft: 12,
							paddingRight: 12,
						}}
					>
						<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>On</span>
						<span
							style={{
								fontSize: 11,
								color: "var(--fg-primary)",
								fontFamily: "var(--font-mono)",
								fontWeight: 500,
							}}
						>
							{currentBranch}
						</span>
					</div>
				)}

				{/* Content */}
				<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
					{loading && changedFiles.length === 0 ? (
						<div
							className="flex items-center justify-center h-32"
							style={{ color: "var(--fg-secondary)", fontSize: 13 }}
						>
							<span className="animate-pulse">Loading changes...</span>
						</div>
					) : error && changedFiles.length === 0 ? (
						<div
							className="flex items-center justify-center h-32 px-4 text-center"
							style={{ color: "var(--fg-secondary)", fontSize: 12 }}
						>
							{error.includes("Not a git repository") || error.includes("not a git repository")
								? "Not a git repository"
								: error}
						</div>
					) : !cwd ? (
						<div
							className="flex items-center justify-center h-32"
							style={{ color: "var(--fg-secondary)", fontSize: 13 }}
						>
							No session selected
						</div>
					) : (
						<div className="flex-1 overflow-y-auto">
							<GitChangesFileList
								files={changedFiles}
								baseBranch={baseBranch}
								onSelectFile={handleSelectFile}
								selectedFile={selectedFile}
							/>
						</div>
					)}
				</div>
			</div>
		</>
	);
}
