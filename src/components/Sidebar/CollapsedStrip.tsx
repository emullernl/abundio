import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceDotStatus } from "../../hooks/useWorkspaceDotStatus";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
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
}

const STRIP_WIDTH = 56;
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
}: Props) {
	const dotStatus = useWorkspaceDotStatus(workspace);
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
					width: STRIP_WIDTH,
					height: `var(--workspace-item-height, ${WORKSPACE_ITEM_HEIGHT_FALLBACK}px)`,
					paddingLeft: 8,
					paddingRight: 4,
					gap: 6,
					backgroundColor: tinted ? "var(--bg-tertiary)" : "transparent",
					borderLeft: isActive
						? "2px solid var(--accent)"
						: "2px solid transparent",
					transition: "background-color var(--transition-fast)",
				}}
			>
				<div style={{ flexShrink: 0, display: "flex" }}>
					<AgentStatusIcon status={dotStatus} />
				</div>
				<span
					className="font-medium overflow-hidden whitespace-nowrap"
					style={{
						color: "var(--fg-primary)",
						fontSize: 12,
						letterSpacing: "0.01em",
						maskImage: "linear-gradient(to right, black 40%, transparent 100%)",
						WebkitMaskImage:
							"linear-gradient(to right, black 40%, transparent 100%)",
					}}
				>
					{workspace.name}
				</span>
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
					</div>,
					document.body,
				)}
		</>
	);
});
