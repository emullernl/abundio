import {
	AppWindow,
	FileText,
	Monitor,
	Printer,
	Search,
	SquareSplitHorizontal,
	SquareSplitVertical,
	Sun,
	X,
} from "lucide-react";
import { usePaneDrag } from "../../hooks/usePaneDrag";
import { useShortcutLabel } from "../../hooks/useShortcutLabel";
import type { MarkdownView } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { File, GitCompare, Image } from "../Icons";
import { MarkdownViewSwitch } from "./MarkdownViewSwitch";

type FileType = "text" | "image" | "pdf" | "binary" | "diff";

interface Props {
	paneId: string;
	fileName: string;
	fileType?: FileType;
	isDirty?: boolean;
	/** Absent where the file is not in a pane layout (an Orchestrator tab):
	 *  no split buttons. */
	onSplitDown?: () => void;
	onSplitRight?: () => void;
	onClose: () => void;
	/** What the close button says it closes. */
	closeLabel?: string;
	/** A markdown file's Rendered / Source switch and the rendered view's
	 *  tools (ADR-0061). */
	markdown?: MarkdownControls;
}

interface MarkdownControls {
	view: MarkdownView;
	onViewChange: (view: MarkdownView) => void;
	/** Merge conflicts: the source is shown and the switch is off. */
	conflicted: boolean;
	onFind: () => void;
	onPrint: () => void;
	onOpenInWindow?: () => void;
}

interface ButtonProps {
	icon: React.ComponentType<{ size?: number }>;
	onClick: () => void;
	label: string;
}

function TitleBarButton({ icon: Icon, onClick, label }: ButtonProps) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: 22,
				height: 22,
				border: "none",
				borderRadius: 4,
				background: "transparent",
				cursor: "pointer",
				color: "var(--fg-secondary)",
				flexShrink: 0,
				padding: 0,
				transition: "background 100ms ease, color 100ms ease",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.background = "var(--bg-tertiary)";
				e.currentTarget.style.color = "var(--fg-primary)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.background = "transparent";
				e.currentTarget.style.color = "var(--fg-secondary)";
			}}
		>
			<Icon size={12} />
		</button>
	);
}

function getExtension(fileName: string): string | null {
	const dot = fileName.lastIndexOf(".");
	return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : null;
}

function getFileIconColor(ext: string | null): string {
	switch (ext) {
		case "ts":
		case "tsx":
			return "#3178c6";
		case "js":
		case "jsx":
		case "mjs":
			return "#f7df1e";
		case "json":
			return "#a8b1c2";
		case "md":
		case "mdx":
			return "#519aba";
		case "css":
		case "scss":
		case "less":
			return "#563d7c";
		case "html":
		case "htm":
			return "#e34c26";
		case "py":
			return "#3572a5";
		case "rs":
			return "#dea584";
		case "go":
			return "#00add8";
		case "java":
			return "#b07219";
		case "c":
		case "cpp":
		case "h":
		case "hpp":
			return "#555555";
		default:
			return "var(--fg-secondary)";
	}
}

export function FilePaneTitleBar({
	paneId,
	fileName,
	fileType,
	isDirty,
	onSplitDown,
	onSplitRight,
	onClose,
	closeLabel = "Close Pane",
	markdown,
}: Props) {
	const ext = getExtension(fileName);
	const { handleMouseDown } = usePaneDrag(paneId);

	let FileIcon: React.ComponentType<{ size?: number }>;
	let iconColor: string;

	if (fileType === "diff") {
		FileIcon = GitCompare;
		iconColor = "var(--accent)";
	} else if (fileType === "image") {
		FileIcon = Image;
		iconColor = "#a074c4";
	} else if (fileType === "pdf") {
		FileIcon = FileText;
		iconColor = "#e5534b";
	} else {
		FileIcon = File;
		iconColor = getFileIconColor(ext);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for pane repositioning
		<div
			className="flex items-center shrink-0"
			style={{
				height: 22,
				padding: "0 4px 0 6px",
				// Transparent so the workspace ambient gradient shows through the
				// pane's title bar too (matches the transparent editor/diff body).
				background: "transparent",
				borderBottom:
					"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
				cursor: "grab",
			}}
			onMouseDown={handleMouseDown}
		>
			<span
				className="shrink-0 flex items-center"
				style={{ marginRight: 5, color: iconColor, opacity: 0.85 }}
			>
				<FileIcon size={13} />
			</span>
			<span
				className="truncate flex-1 min-w-0 select-none"
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					color: "var(--fg-secondary)",
					lineHeight: "22px",
				}}
			>
				{fileName}
			</span>
			{isDirty && (
				<svg
					width={7}
					height={7}
					viewBox="0 0 8 8"
					fill="none"
					aria-label="unsaved changes"
					style={{ flexShrink: 0, marginLeft: 5, marginRight: 3 }}
				>
					<circle cx={4} cy={4} r={3.5} fill="#60a5fa" />
				</svg>
			)}
			{markdown && <MarkdownTools {...markdown} />}
			{onSplitDown && (
				<TitleBarButton
					icon={SquareSplitVertical}
					onClick={onSplitDown}
					label="Split Down"
				/>
			)}
			{onSplitRight && (
				<TitleBarButton
					icon={SquareSplitHorizontal}
					onClick={onSplitRight}
					label="Split Right"
				/>
			)}
			<TitleBarButton icon={X} onClick={onClose} label={closeLabel} />
		</div>
	);
}

function MarkdownTools({
	view,
	onViewChange,
	conflicted,
	onFind,
	onPrint,
	onOpenInWindow,
}: MarkdownControls) {
	const colorMode = useSettingsStore((s) => s.markdownPreviewColorMode);
	const toggleColorMode = useSettingsStore(
		(s) => s.toggleMarkdownPreviewColorMode,
	);
	const findKey = useShortcutLabel("search-in-terminal");
	const toggleKey = useShortcutLabel("toggle-markdown-preview");
	const windowKey = useShortcutLabel("open-markdown-window");
	const withKey = (label: string, key: string) =>
		key ? `${label} (${key})` : label;
	return (
		<>
			{view === "rendered" && (
				<>
					<TitleBarButton
						icon={Search}
						onClick={onFind}
						label={withKey("Find", findKey)}
					/>
					<TitleBarButton
						icon={colorMode === "auto" ? Monitor : Sun}
						onClick={toggleColorMode}
						label={
							colorMode === "auto"
								? "Following the theme. Switch to printed paper"
								: "Printed paper. Switch to following the theme"
						}
					/>
					<TitleBarButton icon={Printer} onClick={onPrint} label="Print" />
					{onOpenInWindow && (
						<TitleBarButton
							icon={AppWindow}
							onClick={onOpenInWindow}
							label={withKey("Open in Separate Window", windowKey)}
						/>
					)}
				</>
			)}
			<span style={{ display: "flex", margin: "0 4px" }}>
				<MarkdownViewSwitch
					view={view}
					onChange={onViewChange}
					size="pane"
					disabled={conflicted}
					title={
						conflicted
							? "Shown as source while the file has merge conflicts"
							: withKey("Switch view", toggleKey)
					}
				/>
			</span>
		</>
	);
}
