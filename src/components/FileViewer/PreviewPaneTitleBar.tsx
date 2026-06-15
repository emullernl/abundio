import {
	Monitor,
	Printer,
	SquareSplitHorizontal,
	SquareSplitVertical,
	Sun,
	X,
} from "lucide-react";
import { usePaneDrag } from "../../hooks/usePaneDrag";
import type { PreviewColorMode } from "../../lib/previewColorMode";

interface Props {
	paneId: string;
	sourceName: string;
	colorMode: PreviewColorMode;
	onToggleColorMode: () => void;
	onPrint: () => void;
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

export function PreviewPaneTitleBar({
	paneId,
	sourceName,
	colorMode,
	onToggleColorMode,
	onPrint,
	onSplitDown,
	onSplitRight,
	onClose,
}: Props) {
	const { handleMouseDown } = usePaneDrag(paneId);

	// The icon reflects the TARGET (what clicking switches to): when following the
	// theme, show the sun (click → white paper); when on white, show the monitor
	// (click → follow theme). Tooltip names the current state and the action. See
	// ADR-0013.
	const followingTheme = colorMode === "auto";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for pane repositioning
		<div
			className="flex items-center shrink-0"
			style={{
				height: 22,
				padding: "0 4px 0 6px",
				// Transparent so the workspace ambient gradient shows through the
				// pane's title bar too (matches the transparent preview body).
				background: "transparent",
				borderBottom:
					"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
				cursor: "grab",
			}}
			onMouseDown={handleMouseDown}
		>
			<span
				className="truncate flex-1 min-w-0 select-none"
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					color: "var(--fg-secondary)",
					lineHeight: "22px",
				}}
			>
				Preview{sourceName ? ` · ${sourceName}` : ""}
			</span>
			<TitleBarButton
				icon={followingTheme ? Sun : Monitor}
				onClick={onToggleColorMode}
				label={
					followingTheme
						? "Preview: follows theme — click for white paper"
						: "Preview: white paper — click to follow theme"
				}
			/>
			<TitleBarButton icon={Printer} onClick={onPrint} label="Print" />
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
