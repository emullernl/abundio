import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmUnloadWorkspace } from "../../hooks/useConfirmUnloadWorkspace";
import { useWorktreeProgress } from "../../hooks/useWorktreeProgress";
import { worktrees } from "../../lib/ipc";
import type { WorkspaceWithTabs } from "../../lib/types";
import {
	buildWorkspaceRows,
	flattenRowsToIds,
	rowId,
	rowWorkspaces,
	type SetRow,
	type WorkspaceRow,
} from "../../lib/worktreeGrouping";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	AddWorktreeDialog,
	type AddWorktreePayload,
} from "../AddWorktreeDialog";
import { ConfirmDialog } from "../ConfirmDialog";
import {
	type ContextMenuItem,
	PaneContextMenu,
} from "../Terminal/PaneContextMenu";
import { WorkspaceSettingsDialog } from "../WorkspaceSettingsDialog";
import { WorktreeProgressDialog } from "../WorktreeProgressDialog";
import { CollapsedStrip } from "./CollapsedStrip";
import { WorkspaceItem } from "./WorkspaceItem";

const DRAG_THRESHOLD = 5;
/** Left indent (px) of a Linked worktree under its Primary — shared by the
 *  expanded rail and the collapsed strip so both read identically. */
const LINKED_INDENT = 14;

interface WorkspaceListProps {
	variant?: "expanded" | "collapsed";
}

/** Per-workspace worktree role, derived from the grouped render rows. */
interface WorkspaceRole {
	/** Main worktree (Primary, or a standalone that can bootstrap a set). */
	isMainWorktree: boolean;
	/** When this workspace is a Linked worktree, the cwd of its set's primary. */
	linkedPrimaryCwd: string | null;
}

export function WorkspaceList({
	variant = "expanded",
}: WorkspaceListProps = {}) {
	const collapsed = variant === "collapsed";
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const switchingWorkspaceId = useWorkspaceStore((s) => s.switchingWorkspaceId);
	const beginWorkspaceSwitch = useWorkspaceStore((s) => s.beginWorkspaceSwitch);
	const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace);
	const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
	const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces);
	const removeWorktreeWorkspace = useWorkspaceStore(
		(s) => s.removeWorktreeWorkspace,
	);
	const createWorktreeWorkspace = useWorkspaceStore(
		(s) => s.createWorktreeWorkspace,
	);
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);

	// "Unload Workspace" tears down the workspace's PTYs; confirm first when an
	// agent is Working or a command is in progress.
	const { requestUnload, dialogProps: unloadDialogProps } =
		useConfirmUnloadWorkspace();

	// Waiting modal for the (potentially slow) create/remove worktree ops.
	const {
		display: worktreeProgress,
		run: runWorktreeProgress,
		dismiss: dismissWorktreeProgress,
	} = useWorktreeProgress();
	// The values from the last create submit, kept so an error's "Edit & retry"
	// can reopen the form pre-filled.
	const [lastCreatePayload, setLastCreatePayload] =
		useState<AddWorktreePayload | null>(null);

	// Derived grouping into render blocks (sets + standalones).
	const rows = useMemo(
		() => buildWorkspaceRows(workspaces, worktreeFacts),
		[workspaces, worktreeFacts],
	);

	// workspaceId → worktree role, for the context menu.
	const roleById = useMemo(() => {
		const map = new Map<string, WorkspaceRole>();
		for (const row of rows) {
			if (row.kind === "set") {
				map.set(row.primary.id, {
					isMainWorktree: true,
					linkedPrimaryCwd: null,
				});
				for (const linked of row.linked) {
					map.set(linked.id, {
						isMainWorktree: false,
						linkedPrimaryCwd: row.primary.rootFolder,
					});
				}
			} else {
				map.set(row.workspace.id, {
					isMainWorktree:
						worktreeFacts[row.workspace.id]?.isMainWorktree ?? false,
					linkedPrimaryCwd: null,
				});
			}
		}
		return map;
	}, [rows, worktreeFacts]);

	const [draggedRowId, setDraggedRowId] = useState<string | null>(null);
	const [mousePos, setMousePos] = useState<{ x: number; y: number }>({
		x: 0,
		y: 0,
	});
	const [ghostWidth, setGhostWidth] = useState(0);
	const [nearestSlot, setNearestSlot] = useState<number | null>(null);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		workspaceId: string;
	} | null>(null);

	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const pendingWorkspace = pendingDeleteId
		? workspaces.find((w) => w.id === pendingDeleteId)
		: null;
	// If the pending-close workspace is a primary with a set, closing it cascades
	// to its linked worktree workspaces (closed too — folders on disk are kept).
	// Scope is taken from `rows` (the rendered grouping), so it always matches
	// what the user sees: if git facts haven't loaded yet the set isn't rendered
	// as a set either, so there's no cascade *and* the dialog shows the plain
	// single-workspace message — no false "will also close N" promise.
	const pendingLinked: WorkspaceWithTabs[] = pendingDeleteId
		? (rows.find(
				(r): r is SetRow =>
					r.kind === "set" && r.primary.id === pendingDeleteId,
			)?.linked ?? [])
		: [];

	// Add worktree dialog target (the primary the worktree is added to). `initial`
	// pre-fills the form when reopening after a failed create.
	const [addWorktreeTarget, setAddWorktreeTarget] = useState<{
		primaryCwd: string;
		primaryName: string;
		initial?: { branch: string; folder: string; selectedIndex: number };
	} | null>(null);

	// Remove worktree confirmation target.
	const [removeWorktreeTarget, setRemoveWorktreeTarget] = useState<{
		workspaceId: string;
		name: string;
		primaryCwd: string;
		worktreePath: string;
		dirty: boolean;
	} | null>(null);

	// Workspace settings dialog target.
	const [settingsWorkspaceId, setSettingsWorkspaceId] = useState<string | null>(
		null,
	);

	const startPos = useRef<{ x: number; y: number } | null>(null);
	const pendingRowId = useRef<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// Block (row) DOM elements, keyed by row index, for slot computation.
	const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map());

	const handleMouseDown = useCallback(
		(e: React.MouseEvent, blockRowId: string) => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest("button")) return;
			e.preventDefault();
			pendingRowId.current = blockRowId;
			startPos.current = { x: e.clientX, y: e.clientY };
		},
		[],
	);

	useEffect(() => {
		if (collapsed) return;
		const onMouseMove = (e: MouseEvent) => {
			if (!startPos.current) return;
			const dx = e.clientX - startPos.current.x;
			const dy = e.clientY - startPos.current.y;
			if (
				Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD &&
				pendingRowId.current
			) {
				setDraggedRowId(pendingRowId.current);
				setGhostWidth(
					containerRef.current?.getBoundingClientRect().width ?? 200,
				);
				pendingRowId.current = null;
			}
		};
		const onMouseUp = () => {
			startPos.current = null;
			pendingRowId.current = null;
		};
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [collapsed]);

	// While dragging a block, track the cursor and compute the nearest drop slot
	// (between blocks). Slots are block boundaries, so a whole set moves as one.
	useEffect(() => {
		if (collapsed) return;
		if (draggedRowId === null) return;
		const draggedIndex = rows.findIndex((r) => rowId(r) === draggedRowId);

		const onMouseMove = (e: MouseEvent) => {
			setMousePos({ x: e.clientX, y: e.clientY });
			let bestSlot: number | null = null;
			let bestDist = Number.POSITIVE_INFINITY;
			for (let i = 0; i <= rows.length; i++) {
				if (i === draggedIndex || i === draggedIndex + 1) continue;
				let slotY: number;
				if (i < rows.length) {
					const el = blockRefs.current.get(i);
					if (!el) continue;
					slotY = el.getBoundingClientRect().top;
				} else {
					const el = blockRefs.current.get(rows.length - 1);
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
			setNearestSlot((slot) => {
				if (slot !== null) {
					const currentIdx = rows.findIndex((r) => rowId(r) === draggedRowId);
					if (
						currentIdx !== -1 &&
						slot !== currentIdx &&
						slot !== currentIdx + 1
					) {
						const reordered = [...rows];
						const [moved] = reordered.splice(currentIdx, 1);
						const insertAt = slot > currentIdx ? slot - 1 : slot;
						reordered.splice(insertAt, 0, moved);
						// Flatten blocks → workspace ids; each set stays contiguous.
						reorderWorkspaces(flattenRowsToIds(reordered));
					}
				}
				return null;
			});
			setDraggedRowId(null);
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [collapsed, draggedRowId, rows, reorderWorkspaces]);

	const draggedRow = draggedRowId
		? rows.find((r) => rowId(r) === draggedRowId)
		: null;

	// Open the dirty-aware Remove-worktree confirm for a linked worktree. Shared
	// by the context-menu item and the row's X button.
	const requestRemoveWorktree = useCallback(
		async (ws: WorkspaceWithTabs, primaryCwd: string) => {
			// Probe dirtiness before showing the (escalated) confirm.
			const dirty = await worktrees.dirty(ws.rootFolder).catch(() => false);
			setRemoveWorktreeTarget({
				workspaceId: ws.id,
				name: ws.name,
				primaryCwd,
				worktreePath: ws.rootFolder,
				dirty,
			});
		},
		[],
	);

	const buildContextMenuItems = useCallback(
		(workspaceId: string): ContextMenuItem[] => {
			const role = roleById.get(workspaceId);
			const ws = workspaces.find((w) => w.id === workspaceId);
			const items: ContextMenuItem[] = [
				{
					label: "Unload Workspace",
					onClick: () => requestUnload(workspaceId),
				},
			];
			if (role?.isMainWorktree && ws) {
				items.push({ separator: true });
				items.push({
					label: "Add worktree…",
					onClick: () =>
						setAddWorktreeTarget({
							primaryCwd: ws.rootFolder,
							primaryName: ws.name,
						}),
				});
			}
			items.push({ separator: true });
			items.push({
				label: "Workspace settings…",
				onClick: () => setSettingsWorkspaceId(workspaceId),
			});
			items.push({
				label: "Rename Workspace",
				onClick: () => setRenamingId(workspaceId),
			});
			// A linked worktree is removed via "Remove worktree…" (deletes the
			// folder), not "Close Workspace" (which would just drop the list entry
			// and leave the worktree on disk to be re-discovered) — so hide it here.
			if (!role?.linkedPrimaryCwd) {
				items.push({
					label: "Close Workspace",
					onClick: () => setPendingDeleteId(workspaceId),
				});
			}
			if (role?.linkedPrimaryCwd && ws) {
				const primaryCwd = role.linkedPrimaryCwd;
				items.push({ separator: true });
				items.push({
					label: "Remove worktree…",
					onClick: () => requestRemoveWorktree(ws, primaryCwd),
				});
			}
			return items;
		},
		[roleById, workspaces, requestUnload, requestRemoveWorktree],
	);

	const contextMenuItems = contextMenu
		? buildContextMenuItems(contextMenu.workspaceId)
		: [];

	// Close the form and run the create behind the waiting modal.
	const handleAddWorktreeSubmit = useCallback(
		(payload: AddWorktreePayload) => {
			setAddWorktreeTarget(null);
			setLastCreatePayload(payload);
			runWorktreeProgress({ verb: "Creating", target: payload.branch }, () =>
				createWorktreeWorkspace(
					payload.primaryCwd,
					payload.branch,
					payload.absolutePath,
					payload.setupCommands,
					payload.agent,
				),
			);
		},
		[runWorktreeProgress, createWorktreeWorkspace],
	);

	// From a create error: dismiss the modal and reopen the form pre-filled.
	const handleEditCreate = useCallback(() => {
		const p = lastCreatePayload;
		dismissWorktreeProgress();
		if (p) {
			setAddWorktreeTarget({
				primaryCwd: p.primaryCwd,
				primaryName: p.primaryName,
				initial: {
					branch: p.branch,
					folder: p.folder,
					selectedIndex: p.selectedIndex,
				},
			});
		}
	}, [lastCreatePayload, dismissWorktreeProgress]);

	// Per-item callbacks shared by standalone + set rendering.
	const itemHandlers = (workspace: WorkspaceWithTabs, blockRowId: string) => ({
		isActive: workspace.id === (switchingWorkspaceId ?? activeWorkspaceId),
		isRenaming: workspace.id === renamingId,
		onClick: () => {
			if (draggedRowId) return;
			beginWorkspaceSwitch(workspace.id);
		},
		onDelete: () => {
			// On a linked worktree the X removes the worktree (deletes the folder),
			// matching the context menu; everywhere else it closes the workspace.
			const role = roleById.get(workspace.id);
			if (role?.linkedPrimaryCwd) {
				requestRemoveWorktree(workspace, role.linkedPrimaryCwd);
			} else {
				setPendingDeleteId(workspace.id);
			}
		},
		onContextMenu: (e: React.MouseEvent) => {
			e.preventDefault();
			setContextMenu({ x: e.clientX, y: e.clientY, workspaceId: workspace.id });
		},
		onRename: (name: string) => {
			renameWorkspace(workspace.id, name);
			setRenamingId(null);
		},
		onRenameCancel: () => setRenamingId(null),
		onMouseDown: (e: React.MouseEvent) => handleMouseDown(e, blockRowId),
	});

	const renderCollapsedStrip = (
		workspace: WorkspaceWithTabs,
		indent: number,
	) => {
		const h = itemHandlers(workspace, `ws:${workspace.id}`);
		return (
			<CollapsedStrip
				key={workspace.id}
				workspace={workspace}
				indent={indent}
				isActive={h.isActive}
				isRenaming={h.isRenaming}
				onClick={h.onClick}
				onDelete={h.onDelete}
				onContextMenu={h.onContextMenu}
				onRename={h.onRename}
				onRenameCancel={h.onRenameCancel}
			/>
		);
	};

	return (
		<div className="flex flex-col" ref={containerRef}>
			{workspaces.length === 0 && !collapsed && (
				<div
					className="px-3 py-4 text-center text-xs"
					style={{ color: "var(--fg-secondary)" }}
				>
					No workspaces yet
				</div>
			)}

			{collapsed
				? // Collapsed strips in grouped display order; Linked worktrees keep
					// the same indentation + rail as the expanded sidebar.
					rows.flatMap((row) =>
						row.kind === "set"
							? [
									renderCollapsedStrip(row.primary, 0),
									...row.linked.map((linked) =>
										renderCollapsedStrip(linked, LINKED_INDENT),
									),
								]
							: [renderCollapsedStrip(row.workspace, 0)],
					)
				: rows.map((row, i) => {
						const id = rowId(row);
						return (
							<div
								key={id}
								ref={(el) => {
									if (el) blockRefs.current.set(i, el);
									else blockRefs.current.delete(i);
								}}
							>
								{nearestSlot === i && <DropIndicator />}
								<WorkspaceRowView
									row={row}
									isDragging={id === draggedRowId}
									itemHandlers={itemHandlers}
								/>
							</div>
						);
					})}

			{!collapsed && nearestSlot === rows.length && <DropIndicator />}

			{!collapsed && draggedRow && (
				<DragGhost row={draggedRow} mousePos={mousePos} width={ghostWidth} />
			)}

			{contextMenu && (
				<PaneContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={contextMenuItems}
					onClose={() => setContextMenu(null)}
				/>
			)}

			{pendingWorkspace && (
				<ConfirmDialog
					title="Close Workspace"
					message={
						pendingLinked.length > 0
							? `Closing "${pendingWorkspace.name}" will also close its ${pendingLinked.length} linked worktree workspace${
									pendingLinked.length === 1 ? "" : "s"
								}. They're removed from your workspace list; the worktree folders on disk are kept. This cannot be undone.`
							: `"${pendingWorkspace.name}" will be permanently removed from your workspace list. This cannot be undone.`
					}
					confirmLabel={
						pendingLinked.length > 0 ? "Close workspaces" : "Close Workspace"
					}
					confirmVariant="danger"
					onConfirm={() => {
						if (pendingDeleteId) {
							// Close the primary and any linked worktrees together. Run
							// them through allSettled so one failed delete doesn't abort
							// the rest and, crucially, isn't swallowed as an unhandled
							// rejection — surface it instead.
							const ids = [pendingDeleteId, ...pendingLinked.map((w) => w.id)];
							Promise.allSettled(ids.map((id) => deleteWorkspace(id))).then(
								(results) => {
									for (const r of results) {
										if (r.status === "rejected") {
											console.error("Failed to close workspace:", r.reason);
										}
									}
								},
							);
						}
						setPendingDeleteId(null);
					}}
					onCancel={() => setPendingDeleteId(null)}
				/>
			)}

			{unloadDialogProps && <ConfirmDialog {...unloadDialogProps} />}

			{addWorktreeTarget && (
				<AddWorktreeDialog
					primaryCwd={addWorktreeTarget.primaryCwd}
					primaryName={addWorktreeTarget.primaryName}
					initialBranch={addWorktreeTarget.initial?.branch}
					initialFolder={addWorktreeTarget.initial?.folder}
					initialSelectedIndex={addWorktreeTarget.initial?.selectedIndex}
					onSubmit={handleAddWorktreeSubmit}
					onClose={() => setAddWorktreeTarget(null)}
				/>
			)}

			{worktreeProgress && (
				<WorktreeProgressDialog
					verb={worktreeProgress.verb}
					target={worktreeProgress.target}
					status={worktreeProgress.status}
					error={worktreeProgress.error}
					onClose={dismissWorktreeProgress}
					onEdit={
						worktreeProgress.verb === "Creating" && lastCreatePayload
							? handleEditCreate
							: undefined
					}
				/>
			)}

			{removeWorktreeTarget && (
				<ConfirmDialog
					title="Remove worktree"
					message={
						removeWorktreeTarget.dirty
							? `"${removeWorktreeTarget.name}" has uncommitted changes that will be permanently lost. This deletes the worktree's folder from disk. The branch is kept.`
							: `This permanently deletes the worktree folder for "${removeWorktreeTarget.name}" from disk. The branch is kept. This cannot be undone.`
					}
					confirmLabel="Remove worktree"
					confirmVariant="danger"
					onConfirm={() => {
						const t = removeWorktreeTarget;
						setRemoveWorktreeTarget(null);
						runWorktreeProgress(
							{ verb: "Removing", target: `'${t.name}'` },
							() =>
								removeWorktreeWorkspace(
									t.workspaceId,
									t.primaryCwd,
									t.worktreePath,
								),
						);
					}}
					onCancel={() => setRemoveWorktreeTarget(null)}
				/>
			)}

			{settingsWorkspaceId && (
				<WorkspaceSettingsDialog
					workspaceId={settingsWorkspaceId}
					isMainWorktree={
						roleById.get(settingsWorkspaceId)?.isMainWorktree ?? false
					}
					onClose={() => setSettingsWorkspaceId(null)}
				/>
			)}
		</div>
	);
}

/** Renders one block: a standalone workspace, or a Worktree set (primary +
 *  indented linked worktrees on a shared rail). The whole block is one drag
 *  unit — grabbing any member drags the set. */
function WorkspaceRowView({
	row,
	isDragging,
	itemHandlers,
}: {
	row: WorkspaceRow;
	isDragging: boolean;
	itemHandlers: (
		workspace: WorkspaceWithTabs,
		blockRowId: string,
	) => Omit<
		React.ComponentProps<typeof WorkspaceItem>,
		"workspace" | "isDragging"
	>;
}) {
	const id = rowId(row);
	if (row.kind === "standalone") {
		return (
			<WorkspaceItem
				workspace={row.workspace}
				isDragging={isDragging}
				{...itemHandlers(row.workspace, id)}
			/>
		);
	}
	return (
		<div style={{ opacity: isDragging ? 0.4 : 1 }}>
			<WorkspaceItem
				workspace={row.primary}
				isDragging={false}
				{...itemHandlers(row.primary, id)}
			/>
			{/* Linked worktrees: indented on a vertical rail tying them to the
			    repo above. Pixel polish via /frontend-design. */}
			<div
				style={{
					position: "relative",
					marginLeft: LINKED_INDENT,
					paddingLeft: 10,
					borderLeft: "2px solid var(--border)",
				}}
			>
				{row.linked.map((linked) => (
					<WorkspaceItem
						key={linked.id}
						workspace={linked}
						isDragging={false}
						{...itemHandlers(linked, id)}
					/>
				))}
			</div>
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
	row,
	mousePos,
	width,
}: {
	row: WorkspaceRow;
	mousePos: { x: number; y: number };
	width: number;
}) {
	const head = rowWorkspaces(row)[0];
	const count = rowWorkspaces(row).length;
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
				workspace={head}
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
			{count > 1 && (
				<div
					className="text-center"
					style={{ fontSize: 10, color: "var(--fg-secondary)", marginTop: 2 }}
				>
					+{count - 1} more worktree{count - 1 > 1 ? "s" : ""}
				</div>
			)}
		</div>
	);
}
