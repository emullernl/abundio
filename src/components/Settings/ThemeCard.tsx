import type { AppTheme } from "../../lib/themes";
import { Check } from "../Icons";

/* ─── Mini terminal preview for theme cards ─── */
function TerminalPreview({ theme }: { theme: AppTheme }) {
	const t = theme.terminal;
	const labels = ["drwx", "file", ".cfg", "app/", "test", "node"] as const;
	const colors = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan];
	return (
		<div
			className="rounded-md overflow-hidden"
			style={{
				backgroundColor: t.background,
				padding: "8px 10px",
				fontFamily: "var(--font-mono)",
				fontSize: 10,
				lineHeight: 1.5,
				letterSpacing: "0.02em",
			}}
		>
			<div style={{ color: t.green ?? "#3fb950" }}>
				<span style={{ color: t.cyan ?? "#58d5ba" }}>~</span>
				<span style={{ color: t.foreground, opacity: 0.5 }}> $ </span>
				<span style={{ color: t.foreground }}>ls -la</span>
			</div>
			<div className="flex gap-2 mt-0.5">
				{colors.map((c, i) => (
					<span key={labels[i]} style={{ color: c ?? "#888" }}>
						{labels[i]}
					</span>
				))}
			</div>
			<div style={{ color: t.foreground, opacity: 0.4, marginTop: 1 }}>
				<span style={{ color: t.cyan ?? "#58d5ba" }}>~</span>
				<span style={{ color: t.foreground, opacity: 0.5 }}> $ </span>
				<span
					style={{
						display: "inline-block",
						width: 6,
						height: 12,
						backgroundColor: t.cursor ?? t.foreground,
						verticalAlign: "middle",
						opacity: 0.8,
					}}
				/>
			</div>
		</div>
	);
}

/* ─── Theme card in a 2-col grid ─── */
export function ThemeCard({
	theme,
	isActive,
	onSelect,
}: {
	theme: AppTheme;
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="text-left rounded-lg transition-all group"
			style={{
				padding: 2,
				background: isActive
					? `linear-gradient(135deg, ${theme.ui.accent}40, ${theme.ui.accent}15)`
					: "transparent",
				border: isActive
					? `1px solid ${theme.ui.accent}60`
					: "1px solid var(--border)",
				outline: isActive ? `1px solid ${theme.ui.accent}30` : "none",
				outlineOffset: 1,
			}}
		>
			<TerminalPreview theme={theme} />
			<div className="flex items-center justify-between px-2 py-1.5">
				<span
					className="text-xs font-medium"
					style={{
						color: isActive ? "var(--accent)" : "var(--fg-secondary)",
					}}
				>
					{theme.displayName}
				</span>
				{isActive && <Check size={12} />}
			</div>
		</button>
	);
}
