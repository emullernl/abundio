import { AlertTriangle, Check, Circle, HelpCircle, Moon } from "lucide-react";
import { memo } from "react";
import type { DotStatus } from "../stores/ptyActivityStore";

/**
 * The colour each status is drawn in, as a CSS value — the same palette the
 * glyphs below carry as Tailwind text classes. Colocated with them so a
 * recolour touches one file: the narrow sidebar's **Hidden rollup** badge is a
 * 7px dot with no glyph to identify it, so it reads this rather than repeating
 * the hex values where a drift would be invisible.
 */
export const DOT_STATUS_COLOR: Record<DotStatus, string> = {
	// Tailwind v4 emits a theme variable only while some utility still uses that
	// colour — every one of these is used by a glyph below — but each carries a
	// literal fallback so a dropped utility can never render an invisible dot.
	grey: "var(--color-zinc-500, rgb(113 113 122))",
	green: "var(--color-emerald-400, rgb(52 211 153))",
	amber: "var(--color-amber-400, rgb(251 191 36))",
	cyan: "var(--color-cyan-400, rgb(34 211 238))",
	purple: "var(--color-purple-400, rgb(192 132 252))",
	red: "var(--color-rose-500, rgb(244 63 94))",
	skyblue: "var(--color-sky-400, rgb(56 189 248))",
};

/** Whether a status animates. The badge dot can't carry the glyph's own motion
 *  at 7px, but it must not sit still while the wide sidebar's chip moves. */
export const DOT_STATUS_ANIMATED: Record<DotStatus, boolean> = {
	grey: false,
	green: false,
	amber: true,
	cyan: true,
	purple: true,
	red: true,
	skyblue: true,
};

interface AgentStatusIconProps {
	status: DotStatus;
	size?: number;
}

export const AgentStatusIcon = memo(function AgentStatusIcon({
	status,
	size = 14,
}: AgentStatusIconProps) {
	switch (status) {
		case "grey":
			return (
				<span className="flex-shrink-0 text-zinc-500">
					<Moon size={size} strokeWidth={2.5} />
				</span>
			);

		case "green":
			return (
				<span className="flex-shrink-0 text-emerald-400 drop-shadow-[0_0_4px_rgba(16,185,129,0.5)]">
					<Circle size={size} strokeWidth={2.5} />
				</span>
			);

		case "amber":
			return (
				<span className="flex-shrink-0 text-amber-400 drop-shadow-[0_0_4px_rgba(251,191,36,0.5)]">
					<svg
						width={size}
						height={size}
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
						style={{
							animation: "agent-amber-spin 1.5s linear infinite",
							transformOrigin: "center",
						}}
					>
						<circle
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeDasharray="15.71 47.12"
						/>
						<circle
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeDasharray="15.71 47.12"
							transform="rotate(180 12 12)"
						/>
					</svg>
				</span>
			);

		case "cyan":
			return (
				<span
					className="flex-shrink-0 text-cyan-400 drop-shadow-[0_0_4px_rgba(34,211,238,0.5)]"
					style={{
						animation: "shell-running-breathe 1.6s ease-in-out infinite",
					}}
				>
					<ShellChevronGlyph size={size} />
				</span>
			);

		case "purple":
			return (
				<div
					className="flex-shrink-0 text-purple-400 drop-shadow-[0_0_3px_rgba(168,85,247,0.4)]"
					style={{
						animation: "agent-purple-bounce 1s ease-in-out infinite",
					}}
				>
					<Check size={size} strokeWidth={2.5} />
				</div>
			);

		case "red":
			return (
				<div
					className="flex-shrink-0 text-rose-500 drop-shadow-[0_0_4px_rgba(244,63,94,0.6)]"
					style={{
						animation: "agent-red-shake 2.4s ease-in-out infinite",
					}}
				>
					<AlertTriangle size={size} strokeWidth={2.5} />
				</div>
			);

		case "skyblue":
			return (
				<div
					className="flex-shrink-0 text-sky-400 drop-shadow-[0_0_4px_rgba(56,189,248,0.6)]"
					style={{
						animation: "agent-skyblue-pulse 1.6s ease-in-out infinite",
					}}
				>
					<HelpCircle size={size} strokeWidth={2.5} />
				</div>
			);
	}
});

/** Three rightward chevrons in a tight horizontal stack — the "running a
 *  command" glyph for a shell-mode PTY. The outer span animates opacity for
 *  the breathing effect; the SVG itself is static. */
export function ShellChevronGlyph({ size = 14 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M5 7l4 5-4 5"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M11 7l4 5-4 5"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M17 7l4 5-4 5"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
