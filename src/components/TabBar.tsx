import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDragPaneStore } from "../lib/dragPaneStore";
import { collectFilePaneIds, parseTabLayout } from "../lib/paneTree";
import type { Tab } from "../lib/types";
import { useExplorerStore } from "../stores/explorerStore";
import {
	computeTabDotStatus,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { AgentStatusIcon } from "./AgentStatusIcon";
import { Terminal } from "./Icons";

interface TabBarProps {
	tabs: Tab[];
	activeTabId: string | undefined;
	onActivate: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onNew: () => void;
	onRename: (tabId: string, name: string) => void;
}

function CloseIcon({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function DirtyDot() {
	return (
		<svg
			width={8}
			height={8}
			viewBox="0 0 8 8"
			fill="none"
			aria-label="unsaved changes"
		>
			<circle cx={4} cy={4} r={3.5} fill="#60a5fa" />
		</svg>
	);
}

function useTabIsDirty(tab: Tab): boolean {
	const fileIds = useMemo(() => {
		const layout = parseTabLayout(tab.layoutJson);
		return layout ? collectFilePaneIds(layout) : [];
	}, [tab.layoutJson]);

	return useExplorerStore((s) =>
		fileIds.some((id) => s.filePanes[id]?.isDirty),
	);
}

function PlusIcon({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M8 3.5V12.5M3.5 8H12.5"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function TabItem({
	tab,
	isActive,
	showSeparator,
	onActivate,
	onClose,
	onDoubleClick,
	onContextMenu,
	editingTabId,
	editValue,
	setEditValue,
	inputRef,
	commitRename,
	cancelRename,
	icon,
	statusDot,
}: {
	tab: Tab;
	isActive: boolean;
	showSeparator: boolean;
	onActivate: () => void;
	onClose: () => void;
	onDoubleClick: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	editingTabId: string | null;
	editValue: string;
	setEditValue: (v: string) => void;
	inputRef: React.RefObject<HTMLInputElement | null>;
	commitRename: () => void;
	cancelRename: () => void;
	icon?: React.ReactNode;
	statusDot?: React.ReactNode;
}) {
	const [hovered, setHovered] = useState(false);
	const dirty = useTabIsDirty(tab);
	const isEditing = editingTabId === tab.id;
	const showClose = isActive || hovered;

	const isDragDwellTarget = useDragPaneStore(
		(s) =>
			s.isDragging &&
			s.hoverTarget?.kind === "tab" &&
			(s.hoverTarget as { tabId: string }).tabId === tab.id,
	);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation handled at tab container level
		<div
			className="flex items-center shrink-0 cursor-pointer relative"
			role="tab"
			tabIndex={0}
			data-tab-id={tab.id}
			style={{
				height: isActive ? 32 : 28,
				paddingLeft: 14,
				paddingRight: 6,
				gap: 8,
				fontSize: 12.5,
				fontFamily: "var(--font-mono)",
				letterSpacing: "0.01em",
				color: isActive
					? "var(--fg-primary)"
					: hovered
						? "var(--fg-primary)"
						: "var(--fg-secondary)",
				// Active tab is transparent so the ambient gradient shows through and
				// it merges with the content area below (its accent top border +
				// side borders mark it active). Inactive tabs get a solid bg-tertiary
				// fill so they clearly read as recessed/unselected chips against the
				// transparent active tab, lifting slightly toward fg on hover.
				backgroundColor: isActive
					? "transparent"
					: hovered
						? "color-mix(in srgb, var(--bg-tertiary) 88%, var(--fg-primary))"
						: "var(--bg-tertiary)",
				borderRadius: "6px 6px 0 0",
				borderTop: isActive
					? "1px solid var(--accent)"
					: "1px solid transparent",
				borderLeft: isActive
					? "1px solid var(--border)"
					: "1px solid transparent",
				borderRight: isActive
					? "1px solid var(--border)"
					: "1px solid transparent",
				transition: "all 150ms ease-out",
				maxWidth: 200,
				minWidth: 0,
				marginTop: "auto",
			}}
			onMouseDown={(e) => {
				if (!isEditing) e.preventDefault();
			}}
			onClick={onActivate}
			onDoubleClick={onDoubleClick}
			onContextMenu={onContextMenu}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{/* Separator between inactive tabs */}
			{showSeparator && (
				<div
					className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-px"
					style={{
						width: 1,
						height: 14,
						backgroundColor: "var(--border)",
						opacity: 0.6,
					}}
				/>
			)}

			{/* Drag-dwell indicator: accent pulse when a pane is hovered over this tab */}
			{isDragDwellTarget && (
				<div
					className="absolute inset-0 pointer-events-none rounded-t"
					style={{
						background: "color-mix(in srgb, var(--accent) 12%, transparent)",
						borderTop: "2px solid var(--accent)",
						animation: "drag-dwell-pulse 0.7s ease-in-out infinite alternate",
					}}
				/>
			)}

			{icon && (
				<span
					style={{
						flexShrink: 0,
						display: "flex",
						alignItems: "center",
						opacity: 0.7,
					}}
				>
					{icon}
				</span>
			)}

			{statusDot}

			{isEditing ? (
				<input
					ref={inputRef}
					type="text"
					value={editValue}
					onChange={(e) => setEditValue(e.target.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitRename();
						if (e.key === "Escape") cancelRename();
						e.stopPropagation();
					}}
					className="bg-transparent outline-none border-none min-w-0"
					style={{
						color: "var(--fg-primary)",
						fontSize: 12.5,
						fontFamily: "var(--font-mono)",
						letterSpacing: "0.01em",
						width: Math.max(48, editValue.length * 7.6),
						padding: 0,
						caretColor: "var(--accent)",
					}}
					onClick={(e) => e.stopPropagation()}
				/>
			) : (
				<span className="truncate select-none">{tab.name}</span>
			)}

			{/* Close button / dirty indicator */}
			{dirty && !hovered ? (
				<button
					type="button"
					className="flex items-center justify-center flex-shrink-0 rounded-sm"
					style={{ width: 20, height: 20, backgroundColor: "transparent" }}
					aria-label="Close tab (unsaved changes)"
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
				>
					<DirtyDot />
				</button>
			) : (
				<CloseButton visible={showClose || dirty} onClick={onClose} />
			)}
		</div>
	);
}

function CloseButton({
	visible,
	onClick,
}: {
	visible: boolean;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);

	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="flex items-center justify-center flex-shrink-0 rounded-md"
			style={{
				width: 20,
				height: 20,
				color: hovered ? "var(--error)" : "var(--fg-secondary)",
				backgroundColor: hovered
					? "color-mix(in srgb, var(--error) 15%, transparent)"
					: "transparent",
				opacity: visible ? (hovered ? 1 : 0.6) : 0,
				transition:
					"opacity 100ms ease-out, background-color 100ms ease-out, color 100ms ease-out",
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<CloseIcon size={12} />
		</button>
	);
}

/** Per-tab status dot that only re-renders when this tab's computed status changes. */
const TabStatusDot = memo(function TabStatusDot({ tab }: { tab: Tab }) {
	const tabDot = usePtyActivityStore((s) =>
		computeTabDotStatus(tab, s.activities, s.panePtyMap),
	);
	if (tabDot === "grey") return null;
	return <AgentStatusIcon status={tabDot} size={12} />;
});

export function TabBar({
	tabs,
	activeTabId,
	onActivate,
	onClose,
	onNew,
	onRename,
}: TabBarProps) {
	const [editingTabId, setEditingTabId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const [contextMenu, setContextMenu] = useState<{
		tabId: string;
		x: number;
		y: number;
	} | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (editingTabId && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editingTabId]);

	// Close context menu on click outside or escape
	useEffect(() => {
		if (!contextMenu) return;
		const handleClick = (e: MouseEvent) => {
			if (
				contextMenuRef.current &&
				!contextMenuRef.current.contains(e.target as Node)
			) {
				setContextMenu(null);
			}
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setContextMenu(null);
		};
		document.addEventListener("mousedown", handleClick, true);
		document.addEventListener("keydown", handleKey, true);
		return () => {
			document.removeEventListener("mousedown", handleClick, true);
			document.removeEventListener("keydown", handleKey, true);
		};
	}, [contextMenu]);

	// Adjust context menu to stay in viewport
	useEffect(() => {
		if (!contextMenu || !contextMenuRef.current) return;
		const rect = contextMenuRef.current.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			contextMenuRef.current.style.left = `${window.innerWidth - rect.width - 8}px`;
		}
		if (rect.bottom > window.innerHeight) {
			contextMenuRef.current.style.top = `${window.innerHeight - rect.height - 8}px`;
		}
	}, [contextMenu]);

	const startRename = useCallback((tab: Tab) => {
		setEditingTabId(tab.id);
		setEditValue(tab.name);
	}, []);

	const commitRename = useCallback(() => {
		if (editingTabId && editValue.trim()) {
			onRename(editingTabId, editValue.trim());
		}
		setEditingTabId(null);
	}, [editingTabId, editValue, onRename]);

	const cancelRename = useCallback(() => {
		setEditingTabId(null);
	}, []);

	const isNewTabDropTarget = useDragPaneStore(
		(s) => s.isDragging && s.hoverTarget?.kind === "new-tab",
	);

	return (
		<div
			className="flex items-end flex-1 min-w-0"
			data-tab-strip
			style={{
				height: 38,
				// Transparent so the workspace ambient gradient shows through the tab
				// strip (the strip's parent paints the gradient — see App.tsx).
				backgroundColor: "transparent",
				paddingLeft: 8,
				paddingRight: 4,
				gap: 1,
			}}
		>
			{/* Scrollable tab area */}
			<div
				className="flex items-end flex-1 min-w-0 overflow-x-auto"
				style={{ gap: 1, scrollbarWidth: "none" }}
				role="tablist"
			>
				{tabs.map((tab, index) => {
					const isActive = tab.id === activeTabId;
					const prevIsActive = index > 0 && tabs[index - 1]?.id === activeTabId;
					const showSeparator = !isActive && index > 0 && !prevIsActive;

					return (
						<TabItem
							key={tab.id}
							tab={tab}
							isActive={isActive}
							showSeparator={showSeparator}
							onActivate={() => onActivate(tab.id)}
							onClose={() => onClose(tab.id)}
							onDoubleClick={() => startRename(tab)}
							onContextMenu={(e) => {
								e.preventDefault();
								setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
							}}
							editingTabId={editingTabId}
							editValue={editValue}
							setEditValue={setEditValue}
							inputRef={inputRef}
							commitRename={commitRename}
							cancelRename={cancelRename}
							icon={<Terminal size={12} />}
							statusDot={<TabStatusDot tab={tab} />}
						/>
					);
				})}
			</div>

			{/* New tab button */}
			<NewTabButton onClick={onNew} isDropTarget={isNewTabDropTarget} />

			{/* Context menu */}
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className="fixed z-[300] rounded-xl shadow-2xl"
					style={{
						left: contextMenu.x,
						top: contextMenu.y,
						minWidth: 200,
						padding: 5,
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
					}}
				>
					<ContextMenuButton
						label="Rename Tab"
						onClick={() => {
							const tab = tabs.find((t) => t.id === contextMenu.tabId);
							if (tab) startRename(tab);
							setContextMenu(null);
						}}
					/>
					<div
						style={{
							height: 1,
							backgroundColor: "var(--border)",
							margin: "4px 8px",
						}}
					/>
					<ContextMenuButton
						label="Close Tab"
						shortcut="&#8984;W"
						onClick={() => {
							onClose(contextMenu.tabId);
							setContextMenu(null);
						}}
					/>
				</div>
			)}
		</div>
	);
}

function NewTabButton({
	onClick,
	isDropTarget,
}: {
	onClick: () => void;
	isDropTarget?: boolean;
}) {
	const [hovered, setHovered] = useState(false);

	return (
		<button
			type="button"
			onClick={onClick}
			data-new-tab-button
			className="flex items-center justify-center flex-shrink-0 rounded-md self-center"
			style={{
				width: 26,
				height: 26,
				color:
					isDropTarget || hovered ? "var(--accent)" : "var(--fg-secondary)",
				backgroundColor: isDropTarget
					? "color-mix(in srgb, var(--accent) 15%, transparent)"
					: hovered
						? "var(--bg-tertiary)"
						: "transparent",
				marginLeft: 4,
				marginBottom: 4,
				transition: "all 120ms ease-out",
				outline: isDropTarget ? "1.5px solid var(--accent)" : "none",
				outlineOffset: 1,
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<PlusIcon size={14} />
		</button>
	);
}

function ContextMenuButton({
	label,
	shortcut,
	onClick,
}: {
	label: string;
	shortcut?: string;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);

	return (
		<button
			type="button"
			className="w-full text-left flex items-center justify-between rounded-md"
			style={{
				color: hovered ? "var(--bg-primary)" : "var(--fg-primary)",
				backgroundColor: hovered ? "var(--accent)" : "transparent",
				fontSize: 13,
				padding: "7px 12px",
				transition: "all 80ms ease-out",
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onClick={onClick}
		>
			<span>{label}</span>
			{shortcut && (
				<span
					style={{
						color: hovered
							? "color-mix(in srgb, var(--bg-primary) 60%, transparent)"
							: "var(--fg-secondary)",
						fontSize: 12,
						fontFamily: "var(--font-mono)",
						transition: "color 80ms ease-out",
					}}
				>
					{shortcut}
				</span>
			)}
		</button>
	);
}
