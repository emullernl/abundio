import { SquareSplitHorizontal, SquareSplitVertical, X } from "lucide-react";
import { File, GitCompare, Image } from "../Icons";

type FileType = "text" | "image" | "binary" | "diff";

interface Props {
	fileName: string;
	fileType?: FileType;
	isDirty?: boolean;
	onSplitDown: () => void;
	onSplitRight: () => void;
	onClose: () => void;
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
	fileName,
	fileType,
	isDirty,
	onSplitDown,
	onSplitRight,
	onClose,
}: Props) {
	const ext = getExtension(fileName);

	let FileIcon: React.ComponentType<{ size?: number }>;
	let iconColor: string;

	if (fileType === "diff") {
		FileIcon = GitCompare;
		iconColor = "var(--accent)";
	} else if (fileType === "image") {
		FileIcon = Image;
		iconColor = "#a074c4";
	} else {
		FileIcon = File;
		iconColor = getFileIconColor(ext);
	}

	return (
		<div
			className="flex items-center shrink-0"
			style={{
				height: 22,
				padding: "0 4px 0 6px",
				background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
				borderBottom:
					"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
			}}
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
			<TitleBarButton
				icon={SquareSplitVertical}
				onClick={onSplitDown}
				label="Split Down"
			/>
			<TitleBarButton
				icon={SquareSplitHorizontal}
				onClick={onSplitRight}
				label="Split Right"
			/>
			<TitleBarButton icon={X} onClick={onClose} label="Close Pane" />
		</div>
	);
}
