import { useEffect, useState } from "react";
import { type GitConflictFile, git } from "../../lib/ipc";
import type { MergeSide } from "../../lib/mergeView";
import { detectLanguage } from "../../lib/monacoShared";
import { relativeToWorkspace } from "../../lib/resolveWorkspacePath";
import { useExplorerStore } from "../../stores/explorerStore";
import { CodeEditor } from "./CodeEditor";

interface Props {
	paneId: string;
	sourcePaneId: string;
	side: MergeSide;
	cwd: string;
	onFocus: () => void;
}

/** Named after the labels git writes into the markers, never ours/theirs —
 *  those invert during a rebase. See ADR-0029. */
const SIDE_LABELS: Record<MergeSide, string> = {
	current: "Current",
	base: "Base",
	incoming: "Incoming",
};

function stageOf(conflict: GitConflictFile, side: MergeSide): string | null {
	if (side === "current") return conflict.ours;
	if (side === "incoming") return conflict.theirs;
	return conflict.base;
}

/**
 * One index stage of a conflicted file, read-only, beside its source pane.
 *
 * Owns no file: it mirrors a stage, the way a preview pane mirrors a buffer.
 * The stages come from the index and never change while the conflict is open,
 * so this fetches once per source pane rather than tracking the buffer.
 */
export function MergeSidePane({
	paneId,
	sourcePaneId,
	side,
	cwd,
	onFocus,
}: Props) {
	const sourcePath = useExplorerStore(
		(s) => s.filePanes[sourcePaneId]?.filePath,
	);
	const [conflict, setConflict] = useState<GitConflictFile | null>(null);
	const [error, setError] = useState<string | null>(null);

	const relativePath = sourcePath ? relativeToWorkspace(cwd, sourcePath) : null;

	useEffect(() => {
		if (!relativePath) return;
		let cancelled = false;
		git
			.conflictFile(cwd, relativePath)
			.then((c) => {
				if (!cancelled) setConflict(c);
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : String(e));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, relativePath]);

	const content = conflict ? stageOf(conflict, side) : null;

	return (
		<div
			className="flex flex-col h-full w-full"
			style={{ backgroundColor: "transparent" }}
			onClick={onFocus}
			onKeyDown={undefined}
		>
			<div
				className="flex items-center gap-2 px-3 flex-shrink-0"
				style={{
					height: 28,
					fontSize: 11,
					fontFamily: "var(--font-ui)",
					borderBottom: "1px solid var(--border)",
					color: "var(--fg-secondary)",
					backgroundColor: "var(--bg-secondary)",
				}}
			>
				<span style={{ color: "var(--fg-primary)", fontWeight: 500 }}>
					{SIDE_LABELS[side]}
				</span>
				<span style={{ opacity: 0.7 }}>read-only</span>
			</div>

			<div className="flex-1 min-h-0">
				{error ? (
					<Message>Could not read this side.</Message>
				) : conflict === null ? (
					<Message>Loading…</Message>
				) : conflict.isBinary ? (
					<Message>Binary file — no text to show.</Message>
				) : content === null ? (
					<Message>
						This side does not exist — the file was deleted here.
					</Message>
				) : (
					<CodeEditor
						tabId={paneId}
						isActive={false}
						content={content}
						language={sourcePath ? (detectLanguage(sourcePath) ?? null) : null}
						initialEditorState={null}
						onChange={() => {}}
						readOnly
					/>
				)}
			</div>
		</div>
	);
}

function Message({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="flex items-center justify-center h-full px-4 text-center"
			style={{ color: "var(--fg-secondary)", fontSize: 12 }}
		>
			{children}
		</div>
	);
}
