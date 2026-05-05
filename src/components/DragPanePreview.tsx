import { File } from "lucide-react";
import { useDragPaneStore } from "../lib/dragPaneStore";
import { useExplorerStore } from "../stores/explorerStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { Terminal } from "./Icons";

function basename(path: string): string {
	if (!path) return "";
	return path.split("/").filter(Boolean).pop() ?? path;
}

export function DragPanePreview() {
	const isDragging = useDragPaneStore((s) => s.isDragging);
	const cursor = useDragPaneStore((s) => s.cursor);
	const sourceRect = useDragPaneStore((s) => s.sourceRect);
	const grabOffset = useDragPaneStore((s) => s.grabOffset);
	const sourcePaneId = useDragPaneStore((s) => s.sourcePaneId);

	const xtermTitle = usePtyActivityStore((s) =>
		sourcePaneId ? (s.titles[sourcePaneId] ?? "") : "",
	);
	const ptyId = usePtyActivityStore((s) =>
		sourcePaneId ? (s.panePtyMap[sourcePaneId] ?? "") : "",
	);
	const runningCmd = usePtyActivityStore((s) =>
		ptyId ? (s.runningCommands[ptyId] ?? "") : "",
	);
	const cwd = usePtyActivityStore((s) => (ptyId ? (s.cwds[ptyId] ?? "") : ""));
	const filePane = useExplorerStore((s) =>
		sourcePaneId ? s.filePanes[sourcePaneId] : undefined,
	);

	if (!isDragging || !sourceRect || !grabOffset || !sourcePaneId) return null;

	const isFile = !!filePane;
	const title = isFile
		? filePane.fileName
		: xtermTitle || runningCmd || basename(cwd) || "Terminal";

	const x = cursor.x - grabOffset.x;
	const y = cursor.y - grabOffset.y;

	return (
		<div
			style={{
				position: "fixed",
				left: x,
				top: y,
				width: sourceRect.width,
				height: sourceRect.height,
				opacity: 0.5,
				pointerEvents: "none",
				zIndex: 400,
				transform: "rotate(-1.5deg)",
				transformOrigin: `${grabOffset.x}px ${grabOffset.y}px`,
				boxShadow: "0 12px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)",
				borderRadius: 4,
				overflow: "hidden",
				border: "1px solid var(--border)",
			}}
		>
			{/* Title bar clone */}
			<div
				style={{
					height: 22,
					padding: "0 4px 0 6px",
					background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
					borderBottom:
						"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
					display: "flex",
					alignItems: "center",
					gap: 5,
					flexShrink: 0,
				}}
			>
				<span
					style={{
						color: "var(--fg-secondary)",
						opacity: 0.7,
						display: "flex",
						alignItems: "center",
					}}
				>
					{isFile ? <File size={13} /> : <Terminal size={12} />}
				</span>
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						color: "var(--fg-secondary)",
						overflow: "hidden",
						whiteSpace: "nowrap",
						textOverflow: "ellipsis",
						flex: 1,
						minWidth: 0,
					}}
				>
					{title}
				</span>
			</div>
			{/* Body */}
			<div
				style={{
					height: "calc(100% - 22px)",
					background: "var(--bg-primary)",
				}}
			/>
		</div>
	);
}
