import { AlertTriangle, Check, Circle, HelpCircle, Moon } from "lucide-react";
import { memo } from "react";
import type { DotStatus } from "../stores/ptyActivityStore";

interface AgentStatusIconProps {
	status: DotStatus;
	size?: number;
	/** Selects the visual variant for amber: "agent" renders the broken
	 *  double-ring spinner; "shell" renders the breathing triple chevron.
	 *  Only affects rendering when `status === "amber"`. Defaults to "agent"
	 *  because rolled-up tab/workspace amber only ever comes from an agent. */
	mode?: "agent" | "shell";
}

export const AgentStatusIcon = memo(function AgentStatusIcon({
	status,
	size = 14,
	mode = "agent",
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
			if (mode === "shell") {
				return (
					<span
						className="flex-shrink-0 text-amber-400 drop-shadow-[0_0_4px_rgba(251,191,36,0.5)]"
						style={{
							animation: "shell-amber-breathe 1.6s ease-in-out infinite",
						}}
					>
						<ShellChevronGlyph size={size} />
					</span>
				);
			}
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
