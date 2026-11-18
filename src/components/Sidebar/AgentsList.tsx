import { Bot, ChevronDown, ChevronRight, List, ListTree } from "lucide-react";
import { useAgentsListGroups } from "../../hooks/useAgentPanes";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AgentRow } from "./AgentRow";

const HEADER_HEIGHT = 30;

/**
 * The **Agents list**: one **Agent row** per agent-mode pane of this
 * Window's Opened workspaces. Grouped by Workspace (the default; groups in
 * Left sidebar order, Agents in **Handle order** inside each) or one flat
 * list in Handle order, switched from the header for the whole app. Never the
 * Fleet Console's derived order: the list is for finding an Agent by its
 * handle. Sits below the Workspace list and collapses to its header.
 */
export function AgentsList() {
	const collapsed = useWindowUiStore((s) => s.agentsListCollapsed);
	const toggle = useWindowUiStore((s) => s.toggleAgentsListCollapsed);
	const setGrouped = useSettingsStore((s) => s.setAgentsListGrouped);
	const { grouped, groups, count } = useAgentsListGroups();

	return (
		<div
			className="flex flex-col min-h-0 h-full"
			style={{ borderTop: collapsed ? "1px solid var(--border)" : "none" }}
		>
			<div
				className="flex items-center flex-shrink-0"
				style={{
					height: HEADER_HEIGHT,
					borderBottom: collapsed ? "none" : "1px solid var(--border)",
				}}
			>
				<button
					type="button"
					onClick={toggle}
					aria-expanded={!collapsed}
					title={collapsed ? "Expand Agents" : "Collapse Agents"}
					className="flex items-center gap-1.5 flex-1 h-full min-w-0 transition-colors hover:bg-[var(--bg-tertiary)]"
					style={{
						paddingLeft: 14,
						paddingRight: 8,
						color: "var(--fg-secondary)",
						transitionDuration: "var(--transition-fast)",
						textAlign: "left",
					}}
				>
					{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
					<Bot size={12} style={{ color: "var(--accent)" }} />
					<span
						className="font-semibold"
						style={{
							fontSize: 11,
							letterSpacing: "0.05em",
							textTransform: "uppercase",
						}}
					>
						Agents
					</span>
					<span
						data-testid="agents-count"
						style={{
							fontSize: 10.5,
							fontVariantNumeric: "tabular-nums",
							opacity: 0.8,
						}}
					>
						· {count}
					</span>
				</button>
				<button
					type="button"
					onClick={() => setGrouped(!grouped)}
					aria-pressed={grouped}
					aria-label="Group by Workspace"
					title={grouped ? "Show as one list" : "Group by Workspace"}
					data-testid="agents-group-toggle"
					className="flex items-center justify-center flex-shrink-0 h-full transition-colors text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
					style={{
						width: 30,
						transitionDuration: "var(--transition-fast)",
					}}
				>
					{grouped ? <ListTree size={13} /> : <List size={13} />}
				</button>
			</div>

			{!collapsed && (
				<div
					className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5"
					style={{ padding: "6px 8px" }}
				>
					{count === 0 ? (
						<div
							style={{
								fontSize: 11.5,
								color: "var(--fg-secondary)",
								padding: "4px 8px",
							}}
						>
							No agents running
						</div>
					) : (
						groups.map((group) => (
							<div
								key={group.workspaceId ?? "all"}
								className="flex flex-col gap-0.5"
								role={grouped ? "group" : undefined}
								data-testid={grouped ? "agents-group" : undefined}
							>
								{group.workspaceId && (
									<GroupLabel workspaceId={group.workspaceId} />
								)}
								{group.tiles.map((tile) => (
									<AgentRow
										key={tile.paneId}
										tile={tile}
										showWorkspace={!grouped}
									/>
								))}
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}

/** A grouped list's plain label: the Workspace's name. */
function GroupLabel({ workspaceId }: { workspaceId: string }) {
	const name = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "",
	);
	return (
		<div
			className="truncate select-none"
			data-testid="agents-group-label"
			style={{
				fontSize: 10.5,
				fontWeight: 600,
				lineHeight: "16px",
				color: "var(--fg-secondary)",
				padding: "6px 10px 2px",
			}}
		>
			{name}
		</div>
	);
}
