import { useState } from "react";
import { usePtyActivityStore, DOT_COLORS, DOT_GLOWS, shouldPulse } from "../../stores/ptyActivityStore";
import type { DotStatus } from "../../stores/ptyActivityStore";
import { getTerminal } from "../../lib/terminalManager";

interface Props {
	paneId: string;
}

function usePtyDotStatus(paneId: string): DotStatus {
	const panePtyId = usePtyActivityStore((s) => s.panePtyMap[paneId] ?? "");
	const ptyId = getTerminal(paneId)?.ptyId || panePtyId;
	return usePtyActivityStore((s) => {
		const entry = s.activities[ptyId];
		if (!entry) return "green";
		switch (entry.state) {
			case "active": return "amber";
			case "waiting": return "purple";
			case "error": return "red";
			default: return "green";
		}
	});
}

export function TerminalTitleBar({ paneId }: Props) {
	const [hovered, setHovered] = useState(false);
	const title = usePtyActivityStore((s) => s.titles[paneId] ?? "");
	const dotStatus = usePtyDotStatus(paneId);

	return (
		<div
			className="flex items-center shrink-0"
			style={{
				height: 22,
				padding: "0 8px",
				background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
				borderBottom: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
			}}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<span
				className="truncate flex-1 min-w-0 select-none"
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					color: hovered ? "var(--fg-primary)" : "var(--fg-secondary)",
					transition: "color 150ms ease-out",
					lineHeight: "22px",
				}}
			>
				{title}
			</span>

			<div
				className={`shrink-0 rounded-full ${shouldPulse(dotStatus) ? "status-dot-pulse" : ""}`}
				style={{
					width: 8,
					height: 8,
					marginLeft: 8,
					backgroundColor: DOT_COLORS[dotStatus],
					"--dot-glow": DOT_GLOWS[dotStatus] ?? "transparent",
				} as React.CSSProperties}
			/>
		</div>
	);
}
