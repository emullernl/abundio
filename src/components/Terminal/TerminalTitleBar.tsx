import { SquareSplitHorizontal, SquareSplitVertical, X } from "lucide-react";
import { usePaneDrag } from "../../hooks/usePaneDrag";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { getTerminal } from "../../lib/terminalManager";
import type { DotStatus } from "../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { Terminal } from "../Icons";

interface Props {
	paneId: string;
	agentId?: string;
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

function usePtyDotStatus(paneId: string): DotStatus {
	const panePtyId = usePtyActivityStore((s) => s.panePtyMap[paneId] ?? "");
	const ptyId = getTerminal(paneId)?.ptyId || panePtyId;
	return usePtyActivityStore((s) => {
		const entry = s.activities[ptyId];
		if (!entry) return "green";
		switch (entry.state) {
			case "active":
				return "amber";
			case "ready":
				return "purple";
			case "error":
				return "red";
			default:
				return "green";
		}
	});
}

function basename(path: string): string {
	if (!path) return "";
	return path.split("/").filter(Boolean).pop() ?? path;
}

export function TerminalTitleBar({
	paneId,
	onSplitDown,
	onSplitRight,
	onClose,
}: Props) {
	const xtermTitle = usePtyActivityStore((s) => s.titles[paneId] ?? "");
	const ptyId = usePtyActivityStore((s) => s.panePtyMap[paneId] ?? "");
	const runningCmd = usePtyActivityStore((s) =>
		ptyId ? (s.runningCommands[ptyId] ?? "") : "",
	);
	const cwd = usePtyActivityStore((s) => (ptyId ? (s.cwds[ptyId] ?? "") : ""));
	const detectedAgentId = usePtyActivityStore((s) =>
		ptyId ? s.detectedAgentIds[ptyId] : undefined,
	);
	const dotStatus = usePtyDotStatus(paneId);

	// Only show agent identity while the agent is actively running (detectedAgentId set).
	// Once it exits and detection clears, fall back to plain terminal title.
	const effectiveAgentId = detectedAgentId;

	const agentName = useSettingsStore((s) =>
		effectiveAgentId
			? s.agents.find((a) => a.id === effectiveAgentId)?.name
			: undefined,
	);

	const title = agentName
		? xtermTitle
			? `${agentName} : ${xtermTitle}`
			: agentName
		: xtermTitle || runningCmd || basename(cwd);

	// Pick the left icon
	const AgentIcon = effectiveAgentId
		? getAgentIconComponent(effectiveAgentId)
		: undefined;
	const showAgentIcon = !!effectiveAgentId;

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
			{/* Left icon */}
			<span
				className="shrink-0 flex items-center"
				style={{ marginRight: 5, color: "var(--fg-secondary)", opacity: 0.7 }}
			>
				{showAgentIcon ? (
					AgentIcon ? (
						<AgentIcon size={14} />
					) : (
						<FallbackAgentIcon size={13} />
					)
				) : (
					<Terminal size={12} />
				)}
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
				{title}
			</span>
			<div className="shrink-0" style={{ marginLeft: 8, marginRight: 12 }}>
				<AgentStatusIcon
					status={dotStatus}
					size={12}
					bgColor="var(--bg-primary)"
				/>
			</div>
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
