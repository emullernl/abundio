import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	type ContextMenuItem,
	PaneContextMenu,
} from "../Terminal/PaneContextMenu";
import { WorkspaceItem } from "./WorkspaceItem";

const DRAG_THRESHOLD = 5;

export function WorkspaceList() {
	const {
		workspaces,
		activeWorkspaceId,
		setActiveWorkspace,
		deleteWorkspace,
		closeWorkspace,
		renameWorkspace,
		reorderWorkspaces,
	} = useWorkspaceStore();

	const [draggedId, setDraggedId] = useState<string | null>(null);
	const [mousePos, setMousePos] = useState<{ x: number; y: number }>({
		x: 0,
		y: 0,
	});
	const [ghostWidth, setGhostWidth] = useState(0);
	const [nearestSlot, setNearestSlot] = useState<number | null>(null);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		workspaceId: string;
	} | null>(null);

	// Inline rename state
	const [renamingId, setRenamingId] = useState<string | null>(null);

	const startPos = useRef<{ x: number; y: number } | null>(null);
	const pendingId = useRef<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// Store refs to each item's DOM element to compute slot positions
	const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

	const handleMouseDown = useCallback((e: React.MouseEvent, id: string) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("button")) return;
		e.preventDefault();
		pendingId.current = id;
		startPos.current = { x: e.clientX, y: e.clientY };
	}, []);

	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!startPos.current) return;
			const dx = e.clientX - startPos.current.x;
			const dy = e.clientY - startPos.current.y;
			if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD && pendingId.current) {
				setDraggedId(pendingId.current);
				setGhostWidth(
					containerRef.current?.getBoundingClientRect().width ?? 200,
				);
				pendingId.current = null;
			}
		};

		const onMouseUp = () => {
			startPos.current = null;
			pendingId.current = null;
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, []);

	// While dragging, track mouse position and compute nearest drop slot
	useEffect(() => {
		if (draggedId === null) return;
		const draggedIndex = workspaces.findIndex((s) => s.id === draggedId);

		const onMouseMove = (e: MouseEvent) => {
			setMousePos({ x: e.clientX, y: e.clientY });

			// Compute which slot the cursor is nearest to
			let bestSlot: number | null = null;
			let bestDist = Number.POSITIVE_INFINITY;

			for (let i = 0; i <= workspaces.length; i++) {
				// Skip adjacent slots (no-op positions)
				if (i === draggedIndex || i === draggedIndex + 1) continue;

				// Slot i is the gap before item i (or after last item)
				let slotY: number;
				if (i < workspaces.length) {
					const el = itemRefs.current.get(i);
					if (!el) continue;
					slotY = el.getBoundingClientRect().top;
				} else {
					const el = itemRefs.current.get(workspaces.length - 1);
					if (!el) continue;
					slotY = el.getBoundingClientRect().bottom;
				}

				const dist = Math.abs(e.clientY - slotY);
				if (dist < bestDist && dist < 40) {
					bestDist = dist;
					bestSlot = i;
				}
			}

			setNearestSlot(bestSlot);
		};

		const onMouseUp = () => {
			// Perform drop if we have a valid slot
			setNearestSlot((slot) => {
				if (slot !== null) {
					const currentIdx = workspaces.findIndex((s) => s.id === draggedId);
					if (
						currentIdx !== -1 &&
						slot !== currentIdx &&
						slot !== currentIdx + 1
					) {
						const ids = workspaces.map((s) => s.id);
						ids.splice(currentIdx, 1);
						const insertAt = slot > currentIdx ? slot - 1 : slot;
						ids.splice(insertAt, 0, draggedId);
						reorderWorkspaces(ids);
					}
				}
				return null;
			});
			setDraggedId(null);
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [draggedId, workspaces, reorderWorkspaces]);

	const draggedWorkspace = draggedId
		? workspaces.find((s) => s.id === draggedId)
		: null;

	const contextMenuItems: ContextMenuItem[] = contextMenu
		? [
				{
					label: "Close Workspace",
					onClick: () => closeWorkspace(contextMenu.workspaceId),
				},
				{ separator: true as const },
				{
					label: "Rename Workspace",
					onClick: () => setRenamingId(contextMenu.workspaceId),
				},
				{
					label: "Delete Workspace",
					onClick: () => deleteWorkspace(contextMenu.workspaceId),
				},
			]
		: [];

	return (
		<div className="flex flex-col" ref={containerRef}>
			{workspaces.length === 0 && (
				<div
					className="px-3 py-4 text-center text-xs"
					style={{ color: "var(--fg-secondary)" }}
				>
					No workspaces yet
				</div>
			)}
			{workspaces.map((workspace, i) => (
				<div
					key={workspace.id}
					ref={(el) => {
						if (el) itemRefs.current.set(i, el);
						else itemRefs.current.delete(i);
					}}
				>
					{nearestSlot === i && <DropIndicator />}
					<WorkspaceItem
						workspace={workspace}
						isActive={workspace.id === activeWorkspaceId}
						isDragging={workspace.id === draggedId}
						isRenaming={workspace.id === renamingId}
						onClick={() => {
							if (draggedId) return;
							setActiveWorkspace(workspace.id);
						}}
						onDelete={() => deleteWorkspace(workspace.id)}
						onContextMenu={(e) => {
							e.preventDefault();
							setContextMenu({
								x: e.clientX,
								y: e.clientY,
								workspaceId: workspace.id,
							});
						}}
						onRename={(name) => {
							renameWorkspace(workspace.id, name);
							setRenamingId(null);
						}}
						onRenameCancel={() => setRenamingId(null)}
						onMouseDown={(e) => handleMouseDown(e, workspace.id)}
					/>
				</div>
			))}
			{nearestSlot === workspaces.length && <DropIndicator />}

			{/* Floating ghost following the cursor */}
			{draggedWorkspace && (
				<DragGhost
					workspace={draggedWorkspace}
					mousePos={mousePos}
					width={ghostWidth}
				/>
			)}

			{/* Workspace context menu */}
			{contextMenu && (
				<PaneContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={contextMenuItems}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</div>
	);
}

function DropIndicator() {
	return (
		<div
			className="mx-2 my-0.5 rounded-md"
			style={{
				height: 36,
				border: "2px dashed var(--accent)",
				backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
			}}
		/>
	);
}

function DragGhost({
	workspace,
	mousePos,
	width,
}: {
	workspace: WorkspaceWithTabs;
	mousePos: { x: number; y: number };
	width: number;
}) {
	return (
		<div
			className="pointer-events-none"
			style={{
				position: "fixed",
				left: mousePos.x + 8,
				top: mousePos.y - 20,
				width,
				opacity: 0.75,
				zIndex: 9999,
				filter: "drop-shadow(0 4px 12px rgba(0, 0, 0, 0.3))",
			}}
		>
			<WorkspaceItem
				workspace={workspace}
				isActive={false}
				isDragging={false}
				isRenaming={false}
				onClick={() => {}}
				onDelete={() => {}}
				onContextMenu={() => {}}
				onRename={() => {}}
				onRenameCancel={() => {}}
				onMouseDown={() => {}}
			/>
		</div>
	);
}
