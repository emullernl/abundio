import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { useAgentPanes } from "../../hooks/useAgentPanes";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { AgentRow } from "./AgentRow";

const HEADER_HEIGHT = 30;

/**
 * The **Agents list**: one **Agent row** per agent-mode pane of this
 * Window's Opened workspaces, in the Fleet Console's derived order. Sits
 * below the Workspace list and collapses to its header.
 */
export function AgentsList() {
	const collapsed = useWindowUiStore((s) => s.agentsListCollapsed);
	const toggle = useWindowUiStore((s) => s.toggleAgentsListCollapsed);
	const panes = useAgentPanes({ includePending: false });

	return (
		<div
			className="flex flex-col min-h-0 h-full"
			style={{ borderTop: collapsed ? "1px solid var(--border)" : "none" }}
		>
			<button
				type="button"
				onClick={toggle}
				aria-expanded={!collapsed}
				title={collapsed ? "Expand Agents" : "Collapse Agents"}
				className="flex items-center gap-1.5 flex-shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
				style={{
					height: HEADER_HEIGHT,
					paddingLeft: 14,
					paddingRight: 14,
					borderBottom: collapsed ? "none" : "1px solid var(--border)",
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
					· {panes.length}
				</span>
			</button>

			{!collapsed && (
				<div
					className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5"
					style={{ padding: "6px 8px" }}
				>
					{panes.length === 0 ? (
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
						panes.map((tile) => <AgentRow key={tile.paneId} tile={tile} />)
					)}
				</div>
			)}
		</div>
	);
}
