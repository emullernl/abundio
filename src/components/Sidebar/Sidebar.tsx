import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef, useState } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Explorer } from "../Explorer/Explorer";
import { ChevronLeft, ChevronRight, Plus } from "../Icons";
import { SessionList } from "./SessionList";

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

export function Sidebar({ titlebarHeight }: SidebarProps) {
	const { createSession } = useSessionStore();
	const {
		sidebarCollapsed,
		toggleSidebar,
		sidebarSplitRatio,
		setSidebarSplitRatio,
	} = useSettingsStore();
	const [creating, setCreating] = useState(false);
	const [localRatio, setLocalRatio] = useState<number | null>(null);

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

	async function handleNewSession() {
		const folder = await open({ directory: true, multiple: false });
		if (!folder) return;

		const folderPath = typeof folder === "string" ? folder : folder[0];
		if (!folderPath) return;

		const name = folderPath.split("/").pop() || "Untitled";
		setCreating(true);
		try {
			await createSession(name, folderPath);
		} catch (err) {
			console.error("Failed to create session:", err);
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
			</div>
		);
	}

	return (
		<div
			className="flex flex-col h-full"
			style={{
				width: "var(--sidebar-width)",
				backgroundColor: "var(--bg-secondary)",
				borderRight: "1px solid var(--border)",
			}}
		>
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
						Sessions
					</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={handleNewSession}
						disabled={creating}
						className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
						style={{ color: "var(--fg-secondary)" }}
						title="New Session"
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

			{/* Split area: Sessions + Explorer */}
			<div className="flex flex-col flex-1 min-h-0">
				{/* Session list */}
				<div
					className="overflow-y-auto px-4 py-2 min-h-0"
					style={{ flex: `${ratio} 1 0%` }}
				>
					<SessionList />
				</div>

				{/* Draggable divider */}
				<SidebarDivider onResize={handleResize} onResizeEnd={handleResizeEnd} />

				{/* Explorer */}
				<div className="min-h-0" style={{ flex: `${1 - ratio} 1 0%` }}>
					<Explorer />
				</div>
			</div>
		</div>
	);
}
