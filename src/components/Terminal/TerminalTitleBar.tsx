import { useState } from "react";
import { getTerminal } from "../../lib/terminalManager";
import type { DotStatus } from "../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { AgentStatusIcon } from "../AgentStatusIcon";

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
			case "active":
				return "amber";
			case "waiting":
				return "purple";
			case "error":
				return "red";
			default:
				return "green";
		}
	});
}

export function TerminalTitleBar({ paneId }: Props) {
	const [hovered, setHovered] = useState(false);
	const title = usePtyActivityStore((s) => s.titles[paneId] ?? "");
	const dotStatus = usePtyDotStatus(paneId);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover state for title bar styling
		<div
			className="flex items-center shrink-0"
			style={{
				height: 22,
				padding: "0 8px",
				background: "color-mix(in srgb, var(--bg-primary) 85%, transparent)",
				borderBottom:
					"1px solid color-mix(in srgb, var(--border) 40%, transparent)",
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

			<div className="shrink-0" style={{ marginLeft: 8 }}>
				<AgentStatusIcon status={dotStatus} size={12} />
			</div>
		</div>
	);
}
