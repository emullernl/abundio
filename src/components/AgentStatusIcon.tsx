import { AlertTriangle, Check, Circle, HelpCircle, Moon } from "lucide-react";
import { memo } from "react";
import type { DotStatus } from "../stores/ptyActivityStore";

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
