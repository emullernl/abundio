import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { Explorer } from "../Explorer/Explorer";
import { ChevronLeft, ChevronRight, Folder, Plus, Search } from "../Icons";
import { SearchPanel } from "../Search/SearchPanel";
import { WorkspaceList } from "./WorkspaceList";

interface SidebarProps {
	titlebarHeight: number;
}

function SidebarDivider({
	onResize,
	onResizeEnd,
}: {
	onResize: (ratio: number) => void;
	onResizeEnd: () => void;
}) {
	const dividerRef = useRef<HTMLDivElement>(null);
	const onResizeEndRef = useRef(onResizeEnd);
	onResizeEndRef.current = onResizeEnd;

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			document.body.classList.add("dragging");

			const parent = dividerRef.current?.parentElement;
			if (!parent) return;

			const parentRect = parent.getBoundingClientRect();

			function onMouseMove(e: MouseEvent) {
				let ratio = (e.clientY - parentRect.top) / parentRect.height;
				ratio = Math.max(0.15, Math.min(0.85, ratio));
				onResize(ratio);
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
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for sidebar resize
		<div
			ref={dividerRef}
			onMouseDown={handleMouseDown}
			className="flex-shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] transition-colors"
			style={{
				height: 4,
				width: "100%",
				cursor: "row-resize",
				transitionDuration: "var(--transition-fast)",
			}}
		/>
	);
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

function PanelTab({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean;
	onClick: () => void;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
			style={{
				color: active ? "var(--accent)" : "var(--fg-secondary)",
				transitionDuration: "var(--transition-fast)",
			}}
		>
			{children}
		</button>
	);
}

export function Sidebar({ titlebarHeight }: SidebarProps) {
	const { createWorkspace } = useWorkspaceStore();
	const {
		sidebarCollapsed,
		toggleSidebar,
		sidebarWidth,
		setSidebarWidth,
		sidebarSplitRatio,
		setSidebarSplitRatio,
		sidebarBottomPanel,
		setSidebarBottomPanel,
	} = useSettingsStore();
	const [creating, setCreating] = useState(false);
	const [localRatio, setLocalRatio] = useState<number | null>(null);
	const [localWidth, setLocalWidth] = useState<number | null>(null);

	const currentWidth = localWidth ?? sidebarWidth;

	const ratio = localRatio ?? sidebarSplitRatio;

	const handleResize = useCallback((r: number) => {
		setLocalRatio(r);
	}, []);

	const handleResizeEnd = useCallback(() => {
		if (localRatio !== null) {
			setSidebarSplitRatio(localRatio);
			setLocalRatio(null);
		}
	}, [localRatio, setSidebarSplitRatio]);

	const handleWidthResize = useCallback((w: number) => {
		setLocalWidth(w);
	}, []);

	const handleWidthResizeEnd = useCallback(() => {
		if (localWidth !== null) {
			setSidebarWidth(localWidth);
			setLocalWidth(null);
		}
	}, [localWidth, setSidebarWidth]);

	async function handleNewWorkspace() {
		const folder = await open({ directory: true, multiple: false });
		if (!folder) return;

		const folderPath = typeof folder === "string" ? folder : folder[0];
		if (!folderPath) return;

		const name = folderPath.split("/").pop() || "Untitled";
		setCreating(true);
		try {
			await createWorkspace(name, folderPath);
		} catch (err) {
			console.error("Failed to create workspace:", err);
		} finally {
			setCreating(false);
		}
	}

	if (sidebarCollapsed) {
		return (
			<div
				className="flex flex-col items-center gap-2"
				style={{
					width: 56,
					paddingTop: titlebarHeight + 8,
					backgroundColor: "var(--bg-secondary)",
					borderRight: "1px solid var(--border)",
				}}
			>
				<button
					type="button"
					onClick={toggleSidebar}
					className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
					style={{ color: "var(--fg-secondary)" }}
				>
					<ChevronRight size={14} />
				</button>
				<button
					type="button"
					onClick={() => {
						toggleSidebar();
						setSidebarBottomPanel("search");
					}}
					className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
					style={{ color: "var(--fg-secondary)" }}
					title="Search in workspace"
				>
					<Search size={14} />
				</button>
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
					paddingLeft: 24,
					paddingRight: 16,
				}}
			>
				<div className="flex items-center gap-2">
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
						disabled={creating}
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

			{/* Split area: Workspaces + Bottom Panel */}
			<div className="flex flex-col flex-1 min-h-0">
				{/* Workspace list */}
				<div
					className="overflow-y-auto px-4 py-2 min-h-0"
					style={{ flex: `${ratio} 1 0%` }}
				>
					<WorkspaceList />
				</div>

				{/* Draggable divider */}
				<SidebarDivider onResize={handleResize} onResizeEnd={handleResizeEnd} />

				{/* Bottom panel with tab selector */}
				<div
					className="min-h-0 flex flex-col"
					style={{ flex: `${1 - ratio} 1 0%` }}
				>
					{/* Panel tabs */}
					<div
						className="flex items-center gap-1 flex-shrink-0"
						style={{
							height: 32,
							paddingLeft: 16,
							paddingRight: 8,
							borderBottom: "1px solid var(--border)",
						}}
					>
						<PanelTab
							active={sidebarBottomPanel === "explorer"}
							onClick={() => setSidebarBottomPanel("explorer")}
							title="Explorer"
						>
							<Folder size={14} />
						</PanelTab>
						<PanelTab
							active={sidebarBottomPanel === "search"}
							onClick={() => setSidebarBottomPanel("search")}
							title="Search"
						>
							<Search size={14} />
						</PanelTab>
					</div>

					{/* Panel content */}
					<div className="flex-1 min-h-0">
						{sidebarBottomPanel === "explorer" ? <Explorer /> : <SearchPanel />}
					</div>
				</div>
			</div>
		</div>
	);
}
