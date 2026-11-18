import { useEffect, useRef, useState } from "react";
import { PEEK_EXPLORER_HANDLE } from "../../lib/orchestratorLayout";
import { openOrchestratorFile } from "../../lib/orchestratorTabs";
import { findPaneLocation } from "../../lib/paneLocation";
import type { Workspace } from "../../lib/types";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FileTree } from "../Explorer/FileTree";

/**
 * The Workspace the **Peek explorer** shows for a peeked pane: the pane's
 * own, or undefined while the pane is not in a layout yet or its folder is
 * missing (then there is nothing to show, and the view gives the room back).
 */
export function usePeekWorkspace(paneId: string): Workspace | undefined {
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
	return ws && !missing.has(ws.id) ? ws : undefined;
}

/**
 * The **Peek explorer**: the peeked Agent's Workspace's file tree, on the
 * right edge of the Peek, read-only. Opening a file makes it a selected
 * **Orchestrator tab**, which sits left of the Peek, so the file and the
 * Agent show side by side. Folders expand as in the Workspace's Explorer
 * tab: the tree shares its state, kept by path. No tooltip on the tree: every
 * row would inherit it.
 *
 * Its width is the view's to decide (`peekLayout`); the handle on its left
 * edge reports drags, in px wider than at the start, and the view keeps the
 * explorer's room shared between the terminal and the left side.
 */
export function PeekExplorer({
	workspace: ws,
	width,
	onDrag,
	onDragEnd,
}: {
	workspace: Workspace;
	width: number;
	/** The width the user is dragging to, from the width at the start. */
	onDrag: (width: number) => void;
	onDragEnd: () => void;
}) {
	const start = useRef<{ x: number; width: number } | null>(null);

	const endDrag = () => {
		if (!start.current) return;
		start.current = null;
		document.body.classList.remove("dragging");
		onDragEnd();
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
				className="shrink-0 hover:bg-[var(--accent)]"
				style={{
					width: PEEK_EXPLORER_HANDLE,
					cursor: "col-resize",
					background: "color-mix(in srgb, var(--border) 40%, transparent)",
				}}
				onPointerDown={(e) => {
					e.preventDefault();
					document.body.classList.add("dragging");
					start.current = { x: e.clientX, width };
					e.currentTarget.setPointerCapture(e.pointerId);
				}}
				onPointerMove={(e) => {
					if (!start.current) return;
					// The explorer's right edge stays put: dragging left widens it.
					onDrag(start.current.width + start.current.x - e.clientX);
				}}
				onPointerUp={(e) => {
					e.currentTarget.releasePointerCapture(e.pointerId);
					endDrag();
				}}
				onLostPointerCapture={endDrag}
			/>
			<div
				data-peek-explorer
				className="shrink-0 min-h-0 overflow-y-auto overflow-x-hidden"
				style={{ width, background: "var(--bg-secondary)" }}
			>
				<FileTree
					rootPath={ws.rootFolder}
					workspaceId={ws.id}
					readOnly
					onOpenFile={openFile}
				/>
			</div>
		</>
	);
}
