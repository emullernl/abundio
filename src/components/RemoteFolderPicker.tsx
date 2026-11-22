import { ArrowUp, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { fs, joinedApi } from "../lib/ipc";
import { lastPart, parentPath, pickableFolders } from "../lib/remoteFolders";
import type { DirEntry } from "../lib/types";
import {
	paramTextInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "./PromptActions/fieldStyles";

/**
 * Choose a folder on the Window's Host (docs/plans/remote-hosts.md phase
 * 10): the native picker only sees this computer. Lists through the Host's
 * own `fs_list_dir`, starting in its home folder.
 */
export function RemoteFolderPicker({
	hostName,
	hostId,
	onPick,
	onCancel,
}: {
	hostName: string;
	/** Browse this Host (a joined Profile's); the Window's own otherwise. */
	hostId?: string;
	onPick: (path: string) => void;
	onCancel: () => void;
}) {
	const [path, setPath] = useState<string | null>(null);
	const [typed, setTyped] = useState("");
	const [entries, setEntries] = useState<DirEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	useEscapeKey(onCancel);

	const open = useCallback(
		async (to: string) => {
			try {
				const list = hostId
					? await joinedApi.callOn<DirEntry[]>(hostId, "fs_list_dir", {
							path: to,
						})
					: await fs.listDir(to);
				setPath(to);
				setTyped(to);
				setEntries(list);
				setError(null);
				listRef.current?.scrollTo(0, 0);
			} catch (e) {
				setError(String(e));
			}
		},
		[hostId],
	);

	useEffect(() => {
		(hostId
			? joinedApi.callOn<string>(hostId, "fs_home_dir", {})
			: fs.homeDir()
		)
			.then(open)
			.catch((e) => setError(String(e)));
	}, [open, hostId]);

	const folders = pickableFolders(entries, showHidden);

	return createPortal(
		<div
			role="presentation"
			className="fixed inset-0 z-[220] flex items-center justify-center"
			style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
		>
			<div
				role="dialog"
				aria-label={`Choose a folder on ${hostName}`}
				className="rounded-2xl flex flex-col gap-3"
				style={{
					width: 520,
					maxHeight: "75vh",
					padding: "20px 22px",
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
					boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
				}}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<h2
					className="font-semibold"
					style={{ fontSize: 15, color: "var(--fg-primary)" }}
				>
					Choose a folder on {hostName}
				</h2>
				<div className="flex items-center gap-2">
					<button
						type="button"
						aria-label="Up one folder"
						className={`${secondaryButtonClass} rounded-md flex items-center justify-center`}
						style={{ width: 30, height: 30, flexShrink: 0 }}
						disabled={path === null || path === "/"}
						onClick={() => path && void open(parentPath(path))}
					>
						<ArrowUp size={14} />
					</button>
					<input
						className="rounded-md flex-1 min-w-0"
						style={{ ...paramTextInputStyle, fontFamily: "var(--font-mono)" }}
						value={typed}
						spellCheck={false}
						autoCapitalize="off"
						onChange={(e) => setTyped(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && typed.trim()) void open(typed.trim());
						}}
					/>
				</div>
				{error && (
					<div style={{ fontSize: 12, color: "var(--error)" }}>{error}</div>
				)}
				<div
					ref={listRef}
					className="flex flex-col overflow-y-auto rounded-md"
					style={{
						minHeight: 220,
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-primary)",
					}}
				>
					{folders.length === 0 && path !== null && (
						<div
							style={{
								padding: "10px 12px",
								fontSize: 12,
								color: "var(--fg-secondary)",
							}}
						>
							No folders here.
						</div>
					)}
					{folders.map((f) => (
						<button
							key={f.path}
							type="button"
							className="flex items-center gap-2 text-left hover:bg-[var(--bg-tertiary)]"
							style={{
								padding: "6px 10px",
								fontSize: 12,
								color: "var(--fg-primary)",
							}}
							onClick={() => void open(f.path)}
						>
							<Folder
								size={14}
								style={{ flexShrink: 0, color: "var(--accent)" }}
							/>
							<span className="truncate">{f.name}</span>
						</button>
					))}
				</div>
				<div className="flex items-center gap-2">
					<label
						className="flex items-center gap-2 flex-1"
						style={{ fontSize: 12, color: "var(--fg-secondary)" }}
					>
						<input
							type="checkbox"
							checked={showHidden}
							onChange={(e) => setShowHidden(e.target.checked)}
						/>
						Show hidden folders
					</label>
					<button
						type="button"
						className={`${secondaryButtonClass} rounded-md`}
						style={{ fontSize: 12, height: 30, padding: "0 14px" }}
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="button"
						className={`${primaryButtonClass} rounded-md`}
						style={{
							fontSize: 12,
							height: 30,
							padding: "0 14px",
							color: "white",
							backgroundColor: "var(--accent)",
						}}
						disabled={path === null}
						onClick={() => path && onPick(path)}
					>
						{path ? `Choose “${lastPart(path)}”` : "Choose"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
