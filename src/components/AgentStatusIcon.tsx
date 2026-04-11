import { AlertTriangle, Check, Circle, Moon } from "lucide-react";
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
				<div
					className="flex-shrink-0 overflow-hidden relative"
					style={{ width: size, height: size }}
				>
					<div
						className="absolute inset-y-0 bg-gradient-to-r from-transparent via-amber-500/20 to-amber-400/90 border-r border-amber-300 shadow-[1px_0_4px_rgba(251,191,36,0.6)]"
						style={{
							width: size,
							animation: "agent-amber-slide 1.2s linear infinite",
						}}
					/>
				</div>
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
	}
});
