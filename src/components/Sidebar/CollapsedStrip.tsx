import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	type HiddenRollup,
	useWorkspaceRollups,
} from "../../hooks/useWorkspaceRollups";
import { shortenPath } from "../../lib/shortenPath";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import {
	AgentStatusIcon,
	DOT_STATUS_ANIMATED,
	DOT_STATUS_COLOR,
} from "../AgentStatusIcon";
import { RollupIcon } from "../RollupIcon";
import { WORKSPACE_ITEM_HEIGHT_FALLBACK, WorkspaceItem } from "./WorkspaceItem";

interface Props {
	workspace: WorkspaceWithTabs;
	isActive: boolean;
	isRenaming: boolean;
	onClick: () => void;
	onDelete: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onRename: (name: string) => void;
	onRenameCancel: () => void;
	/** Set only on a folded set's Primary strip: the hidden Linked worktrees'
	 *  rolled-up status, drawn as a badge dot on the status icons — the more
	 *  urgent of its two rollups, as there is room for one only. */
	hidden?: HiddenRollup;
	/** Left indent (px) for a Linked worktree in a Worktree set; draws a rail.
	 *  Applied as internal padding so the strip's edge — and thus the hover
	 *  popover — stays flush with the sidebar. See ADR-0017. */
	indent?: number;
}

const STRIP_WIDTH = 56;
/** The strip's rollup icons are a size down from the expanded row's 14px, so
 *  each strip's pair stays clear of its neighbours'. The name and folder lines
 *  use the same height, so each sits level with its icon. */
const STRIP_ICON_SIZE = 12;
/** Space between the Agent and Terminal rollups — and between the name and
 *  folder lines. Smaller than the expanded row's `ROLLUP_ROW_GAP` (4px) to
 *  match the smaller icons. */
const STRIP_ROLLUP_GAP = 3;
const POPOVER_DELAY_MS = 100;

export const CollapsedStrip = memo(function CollapsedStrip({
	workspace,
	isActive,
	isRenaming,
	onClick,
	onDelete,
	onContextMenu,
	onRename,
	onRenameCancel,
	hidden,
	indent = 0,
}: Props) {
	const rollups = useWorkspaceRollups(workspace);
	const sidebarWidth = useSettingsStore((s) => s.sidebarWidth);

	const [open, setOpen] = useState(false);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const closeTimerRef = useRef<number | null>(null);

	const cancelClose = useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, POPOVER_DELAY_MS);
	}, [cancelClose]);

	const handleOpen = useCallback(() => {
		cancelClose();
		if (stripRef.current) {
			setRect(stripRef.current.getBoundingClientRect());
		}
		setOpen(true);
	}, [cancelClose]);

	useEffect(() => () => cancelClose(), [cancelClose]);

	// Keep popover position fresh while open: window resize, list scroll, etc.
	// Capture-phase scroll listener catches scroll events from any container.
	useEffect(() => {
		if (!open || !stripRef.current) return;
		const el = stripRef.current;
		const update = () => setRect(el.getBoundingClientRect());
		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [open]);

	// Pin the popover open while the rename input inside it is focused, so a
	// stray mouseleave doesn't unmount the input mid-edit.
	useEffect(() => {
		if (!isRenaming) return;
		cancelClose();
		setOpen(true);
	}, [isRenaming, cancelClose]);

	const tinted = open || isActive;

	return (
		<>
			{/* biome-ignore lint/a11y/useSemanticElements: div used for styling parity with expanded item */}
			<div
				ref={stripRef}
				role="button"
				tabIndex={0}
				onClick={onClick}
				onKeyDown={(e) => e.key === "Enter" && onClick()}
				onContextMenu={onContextMenu}
				onMouseEnter={handleOpen}
				onMouseLeave={scheduleClose}
				onFocus={handleOpen}
				onBlur={scheduleClose}
				className="flex items-center cursor-pointer select-none"
				style={{
					position: "relative",
					width: STRIP_WIDTH,
					height: `var(--workspace-item-height, ${WORKSPACE_ITEM_HEIGHT_FALLBACK}px)`,
					paddingLeft: 8 + indent,
					paddingRight: 4,
					gap: 6,
					backgroundColor: tinted ? "var(--bg-tertiary)" : "transparent",
					borderLeft: isActive
						? "2px solid var(--accent)"
						: "2px solid transparent",
					transition: "background-color var(--transition-fast)",
				}}
			>
				{indent > 0 && (
					// Vertical rail tying Linked worktrees to the Primary above. Each
					// strip draws its own full-height segment, so stacked strips form
					// one continuous line.
					<div
						aria-hidden
						style={{
							position: "absolute",
							left: indent - 2,
							top: 0,
							bottom: 0,
							width: 2,
							backgroundColor: "var(--border)",
						}}
					/>
				)}
				{/* Agent rollup over Terminal rollup, as in the expanded row's left
				    slot (ADR-0032). Each cell keeps its height when empty so the
				    icons never swap places. */}
				<div
					style={{
						flexShrink: 0,
						display: "flex",
						flexDirection: "column",
						gap: STRIP_ROLLUP_GAP,
						width: STRIP_ICON_SIZE,
					}}
					title={hidden ? hidden.membersTooltip : undefined}
				>
					{/* The Hidden-rollup badge hangs off this top cell's top-right
					    corner, so it stays attached to the name's line whether or
					    not a Terminal rollup is drawn below. */}
					<div style={{ height: STRIP_ICON_SIZE, position: "relative" }}>
						{rollups.notOpened ? (
							<AgentStatusIcon status="grey" size={STRIP_ICON_SIZE} />
						) : (
							<RollupIcon
								kind="agent"
								rollup={rollups.agent}
								size={STRIP_ICON_SIZE}
							/>
						)}
						{hidden && (
							<span
								aria-hidden
								data-hidden-badge={hidden.badge}
								style={{
									position: "absolute",
									right: -3,
									top: -2,
									width: 7,
									height: 7,
									borderRadius: "50%",
									backgroundColor: DOT_STATUS_COLOR[hidden.badge],
									// Ring in the strip's own background so the dot reads as
									// separate from the glyph it sits on.
									boxShadow: "0 0 0 1.5px var(--bg-secondary)",
									// A 7px dot can't carry the glyph's own motion (a spinner
									// is mush at this size), but it must not sit still while
									// the wide sidebar's chip moves — so an animated status
									// breathes here. See docs/plans/foldable-worktree-sets.md.
									animation: DOT_STATUS_ANIMATED[hidden.badge]
										? "shell-running-breathe 1.6s ease-in-out infinite"
										: undefined,
								}}
							/>
						)}
					</div>
					<div style={{ height: STRIP_ICON_SIZE }}>
						<RollupIcon
							kind="terminal"
							rollup={rollups.terminal}
							size={STRIP_ICON_SIZE}
						/>
					</div>
				</div>
				{/* Name over folder, as in the expanded row — each level with the
				    rollup icon beside it. Both fade out at the strip's edge. */}
				<div
					className="flex flex-col overflow-hidden whitespace-nowrap min-w-0"
					style={{
						gap: STRIP_ROLLUP_GAP,
						maskImage: "linear-gradient(to right, black 40%, transparent 100%)",
						WebkitMaskImage:
							"linear-gradient(to right, black 40%, transparent 100%)",
					}}
				>
					<span
						className="font-medium"
						style={{
							color: "var(--fg-primary)",
							fontSize: 12,
							lineHeight: `${STRIP_ICON_SIZE}px`,
							letterSpacing: "0.01em",
						}}
					>
						{workspace.name}
					</span>
					<span
						style={{
							color: "var(--fg-secondary)",
							fontSize: 10,
							lineHeight: `${STRIP_ICON_SIZE}px`,
						}}
					>
						{shortenPath(workspace.rootFolder)}
					</span>
				</div>
			</div>

			{open &&
				rect &&
				createPortal(
					// biome-ignore lint/a11y/noStaticElementInteractions: hover-bridge wrapper, not an interactive element itself
					<div
						onMouseEnter={cancelClose}
						onMouseLeave={scheduleClose}
						style={{
							position: "fixed",
							left: rect.left,
							top: rect.top,
							width: sidebarWidth,
							backgroundColor: "var(--bg-secondary)",
							borderRight: "1px solid var(--border)",
							borderTopRightRadius: 6,
							borderBottomRightRadius: 6,
							boxShadow: "8px 4px 24px -6px rgba(0, 0, 0, 0.45)",
							zIndex: 1000,
						}}
					>
						{indent > 0 ? (
							// Indent the popover's contents by the same amount as the
							// collapsed strip (not the deeper expanded-row indent), so the
							// item doesn't jump sideways when the popover opens. The rail
							// matches the strip's rail position.
							<div style={{ position: "relative", paddingLeft: indent }}>
								<div
									aria-hidden
									style={{
										position: "absolute",
										left: indent - 2,
										top: 0,
										bottom: 0,
										width: 2,
										backgroundColor: "var(--border)",
									}}
								/>
								<WorkspaceItem
									workspace={workspace}
									isActive={isActive}
									isDragging={false}
									isRenaming={isRenaming}
									onClick={onClick}
									onDelete={onDelete}
									onContextMenu={onContextMenu}
									onRename={onRename}
									onRenameCancel={onRenameCancel}
									onMouseDown={() => {}}
								/>
							</div>
						) : (
							<WorkspaceItem
								workspace={workspace}
								isActive={isActive}
								isDragging={false}
								isRenaming={isRenaming}
								onClick={onClick}
								onDelete={onDelete}
								onContextMenu={onContextMenu}
								onRename={onRename}
								onRenameCancel={onRenameCancel}
								onMouseDown={() => {}}
								hidden={hidden}
							/>
						)}
					</div>,
					document.body,
				)}
		</>
	);
});
