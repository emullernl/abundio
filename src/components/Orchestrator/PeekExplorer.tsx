import { useEffect, useRef, useState } from "react";
import {
	peekExplorerDragWidth,
	peekExplorerShownWidth,
} from "../../lib/orchestratorLayout";
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
 * tab: the tree shares its state, kept by path. No tooltip on the tree: every
 * row would inherit it.
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
	const missing = useWorkspaceStore((s) => s.missingFolderIds);
	// A pane never changes Workspace, so look it up once per pane: the
	// lookup parses every Tab's layout. Until the pane is in a layout (a
	// helper just started), look again on every layout change.
	// Kept with the pane it was found for, so peeking at another Agent never
	// shows the last one's tree for a render.
	const [found, setFound] = useState<{ paneId: string; wsId: string } | null>(
		null,
	);
	const wsId = found?.paneId === paneId ? found.wsId : undefined;
	const layoutsWhileUnknown = useWorkspaceStore((s) =>
		wsId ? null : s.workspaces,
	);
	useEffect(() => {
		// Layouts change while the pane is unknown: look again.
		if (wsId || !layoutsWhileUnknown) return;
		const id = findPaneLocation(paneId)?.workspaceId;
		if (id) setFound({ paneId, wsId: id });
	}, [paneId, wsId, layoutsWhileUnknown]);
	const ws = useWorkspaceStore((s) =>
		wsId ? s.workspaces.find((w) => w.id === wsId) : undefined,
	);

	// While dragging, the width lives here and is saved on release, like
	// every layout divider; it never goes past what the column can show.
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const shown = peekExplorerShownWidth(dragWidth ?? width, columnWidth);
	const start = useRef<{ x: number; width: number } | null>(null);
	if (!open || !ws || missing.has(ws.id) || shown === 0) return null;

	const endDrag = () => {
		start.current = null;
		document.body.classList.remove("dragging");
		if (dragWidth !== null) setWidth(dragWidth);
		setDragWidth(null);
	};

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
					setDragWidth(
						peekExplorerDragWidth(
							start.current.width + e.clientX - start.current.x,
							columnWidth,
						),
					);
				}}
				onPointerUp={(e) => {
					e.currentTarget.releasePointerCapture(e.pointerId);
					endDrag();
				}}
				onLostPointerCapture={endDrag}
			/>
		</>
	);
}
