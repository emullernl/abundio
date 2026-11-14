import { BellRing } from "lucide-react";
import { useAgentHandle } from "../../hooks/useAgentHandle";
import { usePaneStatus } from "../../hooks/usePaneStatus";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { agentRowTitle } from "../../lib/agentRowTitle";
import type { FleetTile } from "../../lib/fleetConsole";
import { switchToPane } from "../../lib/paneLocation";
import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { useAgentMenu } from "./useAgentMenu";

/**
 * One **Agent row** of the **Agents list**: status icon, Agent icon and the
 * Agent's terminal title, then the Workspace and Tab. Clicking it is
 * **Switch to**; right-clicking opens the **Agent menu**. Each row selects only its own pane's slices, so a chatty
 * Agent's title changes redraw its row, not the list.
 */
export function AgentRow({ tile }: { tile: FleetTile }) {
	const { paneId, ptyId, workspaceId, tabName } = tile;
	const status = usePaneStatus(paneId);
	const xtermTitle = usePtyActivityStore((s) => s.titles[paneId] ?? "");
	const handle = useAgentHandle(paneId);
	const agentId = usePtyActivityStore((s) => s.detectedAgentIds[ptyId]);
	const agentName = useSettingsStore((s) =>
		agentId ? (s.agents.find((a) => a.id === agentId)?.name ?? "") : "",
	);
	const workspaceName = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "",
	);
	const selected = useWorkspaceStore(
		(s) => s.activeWorkspaceId === workspaceId && s.focusedPaneId === paneId,
	);

	// What the Agent says it is doing, and whether it asked for the user
	// (ADR-0056).
	const progress = useAgentSignalsStore((s) => s.progress[paneId]);
	const flag = useAgentSignalsStore((s) => s.flags[paneId]);

	const AgentIcon = (agentId && getAgentIconComponent(agentId)) || undefined;
	const displayName = agentName || "Agent";
	const title = agentRowTitle({
		agentName: displayName,
		xtermTitle,
		handle,
	});
	const tooltip = [
		displayName,
		xtermTitle.trim(),
		`${workspaceName} · ${tabName}`,
		progress,
		flag ? `Wants your attention: ${flag.message}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const label = `${handle ?? displayName} (${workspaceName} · ${tabName})`;
	const menu = useAgentMenu({ paneId, handle, label });

	return (
		<>
			<button
				type="button"
				// Keep DOM focus where it is (the terminal): Switch to focuses the
				// target pane only when the Focused pane changes, so clicking the row
				// of the pane that is already focused would otherwise leave focus on
				// this button and lose the next keystroke.
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => switchToPane(paneId)}
				onContextMenu={(e) => {
					e.preventDefault();
					menu.open(e.clientX, e.clientY);
				}}
				title={tooltip}
				aria-current={selected ? "true" : undefined}
				data-testid="agent-row"
				className={`flex items-start gap-2 w-full rounded-lg cursor-pointer transition-colors select-none text-left ${
					selected
						? "bg-[var(--row-active-bg)]"
						: "hover:bg-[var(--row-hover-bg)]"
				}`}
				style={{
					padding: "6px 10px 6px 8px",
					borderLeft: selected
						? "2px solid var(--accent)"
						: "2px solid transparent",
					transitionDuration: "var(--transition-fast)",
				}}
			>
				<span
					className="flex items-center flex-shrink-0 gap-1.5"
					style={{ height: 18 }}
				>
					<AgentStatusIcon status={status} size={12} />
					<span
						className="flex items-center"
						style={{ color: "var(--fg-secondary)" }}
					>
						{AgentIcon ? (
							<AgentIcon size={13} />
						) : (
							<FallbackAgentIcon size={12} />
						)}
					</span>
				</span>
				<span className="flex flex-col min-w-0 flex-1">
					<span className="flex items-center min-w-0" style={{ gap: 5 }}>
						<span
							className="truncate"
							style={{
								fontSize: 12.5,
								lineHeight: "18px",
								color: "var(--fg-primary)",
							}}
						>
							{title}
						</span>
						{flag && (
							<span
								className="flex-shrink-0 flex items-center"
								style={{ color: "var(--warning)" }}
							>
								<BellRing size={11} />
							</span>
						)}
					</span>
					<span
						className="truncate"
						style={{
							fontSize: 11,
							lineHeight: "15px",
							color: "var(--fg-secondary)",
						}}
					>
						{progress ?? `${workspaceName} · ${tabName}`}
					</span>
				</span>
			</button>
			{menu.element}
		</>
	);
}
