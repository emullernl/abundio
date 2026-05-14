import {
	Printer,
	SquareSplitHorizontal,
	SquareSplitVertical,
	X,
} from "lucide-react";
import { usePaneDrag } from "../../hooks/usePaneDrag";

interface Props {
	paneId: string;
	sourceName: string;
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
	onPrint,
	onSplitDown,
	onSplitRight,
	onClose,
}: Props) {
	const { handleMouseDown } = usePaneDrag(paneId);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle for pane repositioning
		<div
			className="flex items-center shrink-0"
			style={{
				height: 22,
				padding: "0 4px 0 6px",
				background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
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
