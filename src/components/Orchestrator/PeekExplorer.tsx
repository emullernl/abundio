import { useMemo, useRef } from "react";
import { peekExplorerShownWidth } from "../../lib/orchestratorLayout";
import { openOrchestratorFile } from "../../lib/orchestratorTabs";
import { findPaneLocation } from "../../lib/paneLocation";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FileTree } from "../Explorer/FileTree";

/** Width of the drag handle between the Peek explorer and the terminal. */
const HANDLE = 5;

/**
 * The **Peek explorer**: the peeked Agent's Workspace's file tree, on the
 * left edge of the Peek, read-only. Opening a file makes it a selected
 * **Orchestrator tab**, which sits left of the Peek, so the file and the
 * Agent show side by side. Folders expand as in the Workspace's Explorer
 * tab: the tree shares its state, kept by path.
 */
export function PeekExplorer({
	paneId,
	columnWidth,
}: {
	paneId: string;
	/** The Peek column's width, so the terminal keeps its room. */
	columnWidth: number;
}) {
	const open = useWindowUiStore((s) => s.peekExplorerOpen);
	const width = useWindowUiStore((s) => s.peekExplorerWidth);
	const setWidth = useWindowUiStore((s) => s.setPeekExplorerWidth);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const missing = useWorkspaceStore((s) => s.missingFolderIds);
	const ws = useMemo(() => {
		const loc = findPaneLocation(paneId);
		return loc ? workspaces.find((w) => w.id === loc.workspaceId) : undefined;
	}, [workspaces, paneId]);

	const shown = peekExplorerShownWidth(width, columnWidth);
	const start = useRef<{ x: number; width: number } | null>(null);
	if (!open || !ws || missing.has(ws.id) || shown === 0) return null;

	const openFile = (path: string) => {
		void openOrchestratorFile(
			{ workspaceId: ws.id, kind: "file", path },
			{ focus: true },
		)
			.then(() => useOrchestratorStore.getState().set({ fileTabFocused: true }))
			.catch((e) => console.warn("[peek explorer] could not open", e));
	};

	return (
		<>
			<div
				data-peek-explorer
				className="shrink-0 min-h-0 overflow-y-auto overflow-x-hidden"
				style={{ width: shown, background: "var(--bg-secondary)" }}
				title={ws.rootFolder}
			>
				<FileTree
					rootPath={ws.rootFolder}
					workspaceId={ws.id}
					readOnly
					onOpenFile={openFile}
				/>
			</div>
			<div
				className="shrink-0 hover:bg-[var(--accent)]"
				style={{
					width: HANDLE,
					cursor: "col-resize",
					background: "color-mix(in srgb, var(--border) 40%, transparent)",
				}}
				onPointerDown={(e) => {
					e.preventDefault();
					document.body.classList.add("dragging");
					start.current = { x: e.clientX, width: shown };
					e.currentTarget.setPointerCapture(e.pointerId);
				}}
				onPointerMove={(e) => {
					if (!start.current) return;
					setWidth(start.current.width + e.clientX - start.current.x);
				}}
				onPointerUp={(e) => {
					start.current = null;
					document.body.classList.remove("dragging");
					e.currentTarget.releasePointerCapture(e.pointerId);
				}}
				onLostPointerCapture={() => {
					start.current = null;
					document.body.classList.remove("dragging");
				}}
			/>
		</>
	);
}
