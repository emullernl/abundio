import {
	MoreHorizontal,
	Mouse,
	MouseOff,
	SquareSplitHorizontal,
	SquareSplitVertical,
	X,
} from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { usePaneDrag } from "../../hooks/usePaneDrag";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import {
	getTerminal,
	mouseBadgeState,
	subscribePaneRevision,
	togglePaneMouseBlocked,
} from "../../lib/terminalManager";
import type { DotStatus } from "../../stores/ptyActivityStore";
import {
	computePtyDotStatus,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { Terminal } from "../Icons";

interface Props {
	paneId: string;
	agentId?: string;
	onSplitDown: () => void;
	onSplitRight: () => void;
	onClose: () => void;
	/** Open the pane context menu, anchored under the button that was clicked.
	 *  This button is the standing guarantee that the menu is reachable: in a
	 *  mouse-reporting pane the right button belongs to the program, so there is
	 *  no other way in. See ADR-0031. */
	onOpenMenu: (anchor: { x: number; y: number }) => void;
}

interface ButtonProps {
	icon: React.ComponentType<{ size?: number }>;
	onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	label: string;
	/** Marks this button as the thing that raises the pane menu, so the menu's
	 *  outside-click handler leaves its mousedown alone and the button can close
	 *  what it opened. */
	menuAnchor?: boolean;
}

function TitleBarButton({
	icon: Icon,
	onClick,
	label,
	menuAnchor,
}: ButtonProps) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			data-pane-menu-anchor={menuAnchor ? "" : undefined}
			onClick={(e) => {
				e.stopPropagation();
				onClick(e);
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

/** The pane's mouse badge, or nothing at all when the program never asked for
 *  the mouse. Both states are worth surfacing: "blocked" explains why a TUI's
 *  mouse support appears broken — the default configuration's one confusing
 *  moment — and "reporting" explains why right-click stopped opening this
 *  menu. Clicking flips this pane, and only this pane. See ADR-0031. */
function MouseBadge({ paneId }: { paneId: string }) {
	const state = useSyncExternalStore(
		useCallback(
			(onChange: () => void) => subscribePaneRevision(paneId, onChange),
			[paneId],
		),
		useCallback(() => mouseBadgeState(paneId), [paneId]),
		useCallback(() => mouseBadgeState(paneId), [paneId]),
	);

	if (state === "none") return null;

	const blocked = state === "blocked";
	const Icon = blocked ? MouseOff : Mouse;
	const label = blocked
		? "Mouse blocked — this program asked for the mouse and was refused. Click to allow it here."
		: "This program is receiving the mouse, including the right button. Click to block it here.";

	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={!blocked}
			onClick={(e) => {
				e.stopPropagation();
				togglePaneMouseBlocked(paneId);
			}}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: 18,
				height: 18,
				marginLeft: 8,
				border: "none",
				borderRadius: 4,
				background: "transparent",
				cursor: "pointer",
				padding: 0,
				flexShrink: 0,
				// Reporting is the noteworthy state — the program has the mouse and
				// the right button — so it reads at full secondary weight, while a
				// blocked pane sits back as a quiet explanation.
				color: blocked ? "var(--fg-secondary)" : "var(--accent)",
				opacity: blocked ? 0.55 : 0.9,
			}}
		>
			<Icon size={11} />
		</button>
	);
}

function usePtyDotStatus(paneId: string): DotStatus {
	const panePtyId = usePtyActivityStore((s) => s.panePtyMap[paneId] ?? "");
	const ptyId = getTerminal(paneId)?.ptyId || panePtyId;
	return usePtyActivityStore((s) => computePtyDotStatus(ptyId, s.activities));
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
	onOpenMenu,
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
				// Transparent so the workspace ambient gradient shows through the
				// pane's title bar too (matches the transparent terminal/editor body).
				background: "transparent",
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
			<MouseBadge paneId={paneId} />
			<div className="shrink-0" style={{ marginLeft: 8, marginRight: 12 }}>
				<AgentStatusIcon status={dotStatus} size={12} />
			</div>
			<TitleBarButton
				icon={MoreHorizontal}
				onClick={(e) => {
					const r = e.currentTarget.getBoundingClientRect();
					onOpenMenu({ x: r.left, y: r.bottom + 2 });
				}}
				label="Pane Menu"
				menuAnchor
			/>
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
