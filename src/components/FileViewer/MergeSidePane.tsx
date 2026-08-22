import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { sideDecorations } from "../../lib/conflictLenses";
import { mapBlocksToSide, parseConflicts } from "../../lib/conflictMarkers";
import { type GitConflictFile, git } from "../../lib/ipc";
import {
	getActiveConflictBlock,
	subscribeActiveConflictBlock,
} from "../../lib/mergeSync";
import type { MergeSide } from "../../lib/mergeView";
import { detectLanguage } from "../../lib/monacoShared";
import { relativeToWorkspace } from "../../lib/resolveWorkspacePath";
import { useExplorerStore } from "../../stores/explorerStore";
import { CodeEditor, getLiveEditor } from "./CodeEditor";

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

/** Same roles as the rails and the result pane, so a colour always means the
 *  same side wherever you see it. */
const SIDE_COLORS: Record<MergeSide, string> = {
	current: "var(--success)",
	base: "var(--fg-secondary)",
	incoming: "var(--accent)",
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

	// The result pane drives; the sides follow. See `mergeSync`.
	// Both callbacks must be stable: an inline `subscribe` makes React tear down
	// and re-establish the subscription on every render.
	const subscribe = useCallback(
		(fn: () => void) => subscribeActiveConflictBlock(sourcePaneId, fn),
		[sourcePaneId],
	);
	const getSnapshot = useCallback(
		() => getActiveConflictBlock(sourcePaneId),
		[sourcePaneId],
	);
	const activeBlock = useSyncExternalStore(subscribe, getSnapshot);
	const sourceContent = useExplorerStore(
		(s) => s.filePanes[sourcePaneId]?.content,
	);

	const ranges = useMemo(() => {
		if (content == null || sourceContent == null) return [];
		const blocks = parseConflicts(sourceContent);
		return mapBlocksToSide(sourceContent, blocks, content, side);
	}, [content, sourceContent, side]);

	const totalBlocks = ranges.length;

	// Mark every conflict region, emphasise the active one, dim the rest.
	useEffect(() => {
		const ed = getLiveEditor(paneId);
		if (!ed || content == null) return;
		const lineCount = ed.getModel()?.getLineCount() ?? 1;
		const collection = ed.createDecorationsCollection(
			sideDecorations(ranges, activeBlock, lineCount, side),
		);
		return () => collection.clear();
	}, [activeBlock, ranges, paneId, content, side]);

	// Follow the caret. Split from the decoration effect so re-decorating (on an
	// edit in the result pane) never yanks the viewport out from under a scroll.
	useEffect(() => {
		const ed = getLiveEditor(paneId);
		const range = activeBlock === null ? null : ranges[activeBlock];
		if (!ed || !range) return;
		ed.revealRangeInCenter({
			startLineNumber: range.startLine,
			startColumn: 1,
			endLineNumber: Math.max(range.startLine, range.endLine),
			endColumn: 1,
		});
	}, [activeBlock, ranges, paneId]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: click-to-focus on pane container
		// biome-ignore lint/a11y/noStaticElementInteractions: layout container, click-to-focus only
		<div
			className="flex flex-col h-full w-full"
			style={{ backgroundColor: "transparent" }}
			onClick={onFocus}
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
					// A hairline in the side's own colour, echoing its gutter rails.
					boxShadow: `inset 0 2px 0 0 ${SIDE_COLORS[side]}`,
				}}
			>
				<span
					className="inline-block flex-shrink-0 rounded-full"
					style={{
						width: 6,
						height: 6,
						backgroundColor: SIDE_COLORS[side],
					}}
				/>
				<span style={{ color: "var(--fg-primary)", fontWeight: 500 }}>
					{SIDE_LABELS[side]}
				</span>
				{activeBlock !== null && totalBlocks > 0 && (
					<span
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: 10,
							opacity: 0.8,
						}}
					>
						{activeBlock + 1}/{totalBlocks}
					</span>
				)}
				<span className="flex-1" />
				<span style={{ opacity: 0.55 }}>read-only</span>
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
