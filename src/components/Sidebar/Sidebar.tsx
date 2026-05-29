import { useCallback, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { ChevronLeft, ChevronRight, Grid, Plus } from "../Icons";
import { WorkspaceList } from "./WorkspaceList";

interface SidebarProps {
	titlebarHeight: number;
	onRequestNewWorkspace: () => void;
}

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 280;

function SidebarEdgeHandle({
	onResize,
	onResizeEnd,
}: {
	onResize: (width: number) => void;
	onResizeEnd: () => void;
}) {
	const onResizeEndRef = useRef(onResizeEnd);
	onResizeEndRef.current = onResizeEnd;

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			document.body.classList.add("dragging");

			const startX = e.clientX;
			const sidebar = (e.target as HTMLElement).parentElement;
			if (!sidebar) return;
			const startWidth = sidebar.getBoundingClientRect().width;

			function onMouseMove(e: MouseEvent) {
				const newWidth = Math.max(
					SIDEBAR_MIN_WIDTH,
					Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)),
				);
				onResize(newWidth);
			}

			function onMouseUp() {
				document.body.classList.remove("dragging");
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				onResizeEndRef.current();
			}

			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[onResize],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for sidebar width resize
		<div
			onMouseDown={handleMouseDown}
			onDoubleClick={() => {
				onResize(SIDEBAR_DEFAULT_WIDTH);
				onResizeEndRef.current();
			}}
			style={{
				position: "absolute",
				top: 0,
				right: 0,
				width: 4,
				height: "100%",
				cursor: "col-resize",
				zIndex: 10,
			}}
			className="hover:bg-[var(--accent)] transition-colors"
		/>
	);
}

export function Sidebar({
	titlebarHeight,
	onRequestNewWorkspace,
}: SidebarProps) {
	const { sidebarWidth, setSidebarWidth } = useSettingsStore();
	// Sidebar collapsed state is per-Window (each OS window remembers its own
	// layout). See windowUiStore + ADR-0007.
	const sidebarCollapsed = useWindowUiStore((s) => s.sidebarCollapsed);
	const toggleSidebar = useWindowUiStore((s) => s.toggleSidebar);
	const [localWidth, setLocalWidth] = useState<number | null>(null);

	const currentWidth = localWidth ?? sidebarWidth;

	const handleWidthResize = useCallback((w: number) => {
		setLocalWidth(w);
	}, []);

	const handleWidthResizeEnd = useCallback(() => {
		if (localWidth !== null) {
			setSidebarWidth(localWidth);
			setLocalWidth(null);
		}
	}, [localWidth, setSidebarWidth]);

	function handleNewWorkspace() {
		onRequestNewWorkspace();
	}

	if (sidebarCollapsed) {
		return (
			<div
				className="flex flex-col h-full"
				style={{
					width: 56,
					paddingTop: titlebarHeight + 8,
					backgroundColor: "var(--bg-secondary)",
					borderRight: "1px solid var(--border)",
				}}
			>
				<div className="flex flex-col items-center flex-shrink-0 pb-2">
					<button
						type="button"
						onClick={toggleSidebar}
						className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
						style={{ color: "var(--fg-secondary)" }}
					>
						<ChevronRight size={14} />
					</button>
				</div>
				<div
					className="flex-shrink-0"
					style={{
						height: 1,
						marginLeft: 8,
						marginRight: 8,
						backgroundColor: "var(--border)",
						opacity: 0.6,
					}}
				/>
				<div className="flex-1 overflow-y-auto overflow-x-hidden pt-1">
					<WorkspaceList variant="collapsed" />
				</div>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col h-full relative"
			style={{
				width: currentWidth,
				backgroundColor: "var(--bg-secondary)",
				borderRight: "1px solid var(--border)",
			}}
		>
			<SidebarEdgeHandle
				onResize={handleWidthResize}
				onResizeEnd={handleWidthResizeEnd}
			/>
			{/* Titlebar spacer */}
			<div
				data-tauri-drag-region
				style={{ height: titlebarHeight, flexShrink: 0 }}
			/>

			{/* Header */}
			<div
				className="flex items-center justify-between flex-shrink-0"
				style={{
					borderBottom: "1px solid var(--border)",
					height: 40,
					paddingLeft: 14,
					paddingRight: 16,
				}}
			>
				<div className="flex items-center gap-2">
					<Grid size={12} style={{ color: "var(--fg-secondary)" }} />
					<span
						className="font-semibold"
						style={{
							color: "var(--fg-secondary)",
							fontSize: 11,
							letterSpacing: "0.05em",
							textTransform: "uppercase",
						}}
					>
						Workspaces
					</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={handleNewWorkspace}
						className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
						style={{ color: "var(--fg-secondary)" }}
						title="New Workspace"
					>
						<Plus size={14} />
					</button>
					<button
						type="button"
						onClick={toggleSidebar}
						className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
						style={{ color: "var(--fg-secondary)" }}
						title="Collapse sidebar"
					>
						<ChevronLeft size={14} />
					</button>
				</div>
			</div>

			{/* Workspace list — fills the rest of the sidebar (the bottom split
			 *  + Explorer/Search tab strip moved to the right sidebar per ADR-0010). */}
			<div className="overflow-y-auto px-4 py-2 flex-1 min-h-0">
				<WorkspaceList />
			</div>
		</div>
	);
}
