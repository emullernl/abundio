import "@xyflow/react/dist/style.css";
import {
	type Edge,
	Handle,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	useReactFlow,
} from "@xyflow/react";
import { BellRing, Network, RefreshCw } from "lucide-react";
import {
	createContext,
	memo,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useAgentHandle } from "../../hooks/useAgentHandle";
import { useConfirmCloseWorkspace } from "../../hooks/useConfirmCloseWorkspace";
import { usePaneStatus } from "../../hooks/usePaneStatus";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import {
	type ControlActivity,
	subscribeControlActivity,
} from "../../lib/controlActivity";
import { openNewTask } from "../../lib/openNewTask";
import { orchestratorPane } from "../../lib/orchestrator";
import {
	askAboutText,
	askOrchestrator,
	peekAgent,
} from "../../lib/orchestratorActions";
import {
	type GraphAgent,
	type GraphWorkspace,
	graphModel,
	layoutGraph,
} from "../../lib/orchestratorGraph";
import { restartOrchestrator } from "../../lib/orchestratorSession";
import { switchToPane } from "../../lib/paneLocation";
import {
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { NewAgentDialog } from "../FleetConsole/NewAgentDialog";
import { openInBackground } from "../FleetConsole/WorkspacePicker";
import { primaryButtonClass } from "../PromptActions/fieldStyles";
import { useAgentMenu } from "../Sidebar/useAgentMenu";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";

/** How long an Agent control call stays drawn on the graph. */
const PULSE_MS = 2600;

const ORCH_NODE = "orchestrator";
const wsNodeId = (id: string) => `ws:${id}`;
const agentNodeId = (paneId: string) => `agent:${paneId}`;

type AgentData = { agent: GraphAgent; workspaceName: string; fresh: boolean };
type WorkspaceData = { ws: GraphWorkspace };
type AgentNodeT = Node<AgentData, "agent">;
type WorkspaceNodeT = Node<WorkspaceData, "workspace">;
type OrchNodeT = Node<Record<string, never>, "orchestrator">;

/** What a node can ask the graph to do. */
interface GraphActions {
	showDormant: (agent: GraphAgent, x: number, y: number) => void;
	closeWorkspace: (workspaceId: string) => void;
	newAgentIn: (workspaceId: string) => void;
}
const ActionsContext = createContext<GraphActions | null>(null);

const hiddenHandle = {
	opacity: 0,
	width: 1,
	height: 1,
	minWidth: 0,
	minHeight: 0,
};

/**
 * The **Orchestrator view**'s graph (ADR-0057): the Orchestrator on top, one
 * box per Workspace of the Profile, its Agents inside. Single click peeks,
 * double click is **Switch to**, right click opens the Agent menu. Agent
 * control calls between panes are drawn as edges that fade.
 */
export function OrchestratorGraph() {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const facts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const opened = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const panePtyMap = usePtyActivityStore((s) => s.panePtyMap);
	const activities = usePtyActivityStore((s) => s.activities);
	const orchestratorWsId = useOrchestratorStore((s) => s.workspaceId);
	const selected = useOrchestratorStore((s) => s.selectedPaneId);

	// Which Agents are in agent mode changes far less often than activities
	// do: key the model on that, not on every status tick.
	const agentPtyKey = useMemo(
		() =>
			Object.entries(activities)
				.filter(([, a]) => a?.detectionMode === "agent")
				.map(([id]) => id)
				.sort()
				.join(","),
		[activities],
	);
	const model = useMemo(() => {
		const agentPtys = new Set(agentPtyKey ? agentPtyKey.split(",") : []);
		return graphModel({
			workspaces,
			order: flattenRowsToIds(buildWorkspaceRows(workspaces, facts)),
			openedWorkspaceIds: opened,
			panePtyMap,
			isAgentPty: (p) => agentPtys.has(p),
		});
	}, [workspaces, facts, opened, panePtyMap, agentPtyKey]);
	// The graph's shape follows its area's, so many Workspaces wrap into rows.
	const areaRef = useRef<HTMLDivElement>(null);
	const [aspect, setAspect] = useState(4);
	useEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		const measure = () => {
			if (el.clientHeight > 0) {
				// Rounded, so a divider drag does not re-lay out on every pixel.
				setAspect(Math.round((el.clientWidth / el.clientHeight) * 2) / 2);
			}
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const layout = useMemo(() => layoutGraph(model, aspect), [model, aspect]);

	const orchestratorPaneId = useMemo(() => {
		const ws = workspaces.find((w) => w.id === orchestratorWsId);
		return ws ? (orchestratorPane(ws.tabs)?.paneId ?? null) : null;
	}, [workspaces, orchestratorWsId]);

	// Agents that appear after the graph first drew grow in (spawned).
	const known = useRef<Set<string> | null>(null);
	const fresh = useMemo(() => {
		const ids = model.flatMap((w) => w.agents.map((a) => a.paneId));
		if (known.current === null) {
			known.current = new Set(ids);
			return new Set<string>();
		}
		const now = new Set(ids.filter((id) => !known.current?.has(id)));
		for (const id of ids) known.current.add(id);
		return now;
	}, [model]);

	const nodes = useMemo(() => {
		const out: Node[] = [
			{
				id: ORCH_NODE,
				type: "orchestrator",
				position: { x: layout.orchestrator.x, y: layout.orchestrator.y },
				data: {},
				draggable: false,
				selectable: false,
			} satisfies OrchNodeT,
		];
		for (const ws of model) {
			const box = layout.boxes[ws.id];
			out.push({
				id: wsNodeId(ws.id),
				type: "workspace",
				position: { x: box.x, y: box.y },
				style: { width: box.width, height: box.height },
				data: { ws },
				draggable: false,
				selectable: false,
			} satisfies WorkspaceNodeT);
			for (const agent of ws.agents) {
				const p = layout.agents[agent.paneId];
				out.push({
					id: agentNodeId(agent.paneId),
					type: "agent",
					parentId: wsNodeId(ws.id),
					extent: "parent",
					position: { x: p.x, y: p.y },
					style: { width: p.width, height: p.height },
					data: {
						agent,
						workspaceName: ws.name,
						fresh: fresh.has(agent.paneId),
					},
					draggable: false,
					selected: agent.paneId === selected,
				} satisfies AgentNodeT);
			}
		}
		return out;
	}, [model, layout, fresh, selected]);

	// ── Agent control calls, drawn for a moment ──
	const [pulses, setPulses] = useState<ControlActivity[]>([]);
	useEffect(
		() =>
			subscribeControlActivity((a) => {
				setPulses((list) => [
					...list.filter(
						(p) =>
							!(
								p.callerPaneId === a.callerPaneId &&
								p.targetPaneId === a.targetPaneId
							),
					),
					a,
				]);
				setTimeout(
					() => setPulses((list) => list.filter((p) => p !== a)),
					PULSE_MS,
				);
			}),
		[],
	);

	const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
	const edges = useMemo(() => {
		const out: Edge[] = model.map((ws) => ({
			id: `tree:${ws.id}`,
			source: ORCH_NODE,
			target: wsNodeId(ws.id),
			type: "smoothstep",
			style: {
				stroke: "color-mix(in srgb, var(--border) 90%, var(--fg-secondary))",
				strokeWidth: 1.2,
				opacity: ws.opened ? 1 : 0.5,
			},
		}));
		const endpoint = (paneId: string) =>
			paneId === orchestratorPaneId ? ORCH_NODE : agentNodeId(paneId);
		for (const p of pulses) {
			const source = endpoint(p.callerPaneId);
			const target = endpoint(p.targetPaneId);
			if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
			out.push({
				id: `call:${p.callerPaneId}:${p.targetPaneId}:${p.at}`,
				source,
				target,
				sourceHandle: "side",
				targetHandle: "side-in",
				animated: true,
				// Above the Workspace boxes, or a call between two of them is
				// hidden behind them.
				zIndex: 1000,
				className: `orch-call orch-call-${p.kind}`,
				style: {
					stroke: p.kind === "act" ? "var(--accent)" : "var(--fg-secondary)",
					strokeWidth: p.kind === "act" ? 2.2 : 1.4,
					strokeDasharray: p.kind === "read" ? "3 4" : undefined,
				},
			});
		}
		return out;
	}, [model, pulses, nodeIds, orchestratorPaneId]);

	// ── Graph-level dialogs ──
	const [dormant, setDormant] = useState<{
		agent: GraphAgent;
		x: number;
		y: number;
	} | null>(null);
	const [newAgentWs, setNewAgentWs] = useState<string | null>(null);
	const { requestClose, dialogProps } = useConfirmCloseWorkspace();
	const actions = useMemo<GraphActions>(
		() => ({
			showDormant: (agent, x, y) => setDormant({ agent, x, y }),
			closeWorkspace: requestClose,
			newAgentIn: setNewAgentWs,
		}),
		[requestClose],
	);

	return (
		<ActionsContext.Provider value={actions}>
			<div ref={areaRef} className="absolute inset-0 orch-graph">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={NODE_TYPES}
					fitView
					fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
					minZoom={0.25}
					maxZoom={1.6}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable
					zoomOnDoubleClick={false}
					onNodeClick={(e, node) => {
						if (node.type !== "agent") return;
						const { agent } = node.data as AgentData;
						if (agent.dormant) {
							actions.showDormant(agent, e.clientX, e.clientY);
						} else {
							peekAgent(agent.paneId);
						}
					}}
					onNodeDoubleClick={(_, node) => {
						if (node.type !== "agent") return;
						switchToPane((node.data as AgentData).agent.paneId);
					}}
					onPaneClick={() => {
						useOrchestratorStore.getState().set({ selectedPaneId: null });
						setDormant(null);
					}}
				>
					<FitOnChange count={nodes.length} aspect={aspect} />
				</ReactFlow>
				{model.length === 0 && (
					<div
						className="absolute inset-x-0 flex justify-center pointer-events-none"
						style={{ bottom: 24, fontSize: 12, color: "var(--fg-secondary)" }}
					>
						No agents yet. Ask the Orchestrator to start one, or start one from
						a workspace.
					</div>
				)}
				{dormant && (
					<DormantCard {...dormant} onClose={() => setDormant(null)} />
				)}
			</div>
			{newAgentWs && (
				<NewAgentDialog
					initialWorkspaceId={newAgentWs}
					onClose={() => setNewAgentWs(null)}
				/>
			)}
			{dialogProps && <ConfirmDialog {...dialogProps} />}
		</ActionsContext.Provider>
	);
}

/** Re-fits the view when Agents come or go, so nobody lands off screen. */
function FitOnChange({ count, aspect }: { count: number; aspect: number }) {
	const flow = useReactFlow();
	const first = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-fit whenever the node count or the area's shape changes
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		const id = requestAnimationFrame(() =>
			flow.fitView({ padding: 0.15, maxZoom: 1.1, duration: 300 }),
		);
		return () => cancelAnimationFrame(id);
	}, [count, aspect, flow]);
	return null;
}

// ── Nodes ──

const OrchestratorNode = memo(function OrchestratorNode() {
	const workspaceId = useOrchestratorStore((s) => s.workspaceId);
	const phase = useOrchestratorStore((s) => s.phase);
	const tabs = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === workspaceId)?.tabs,
	);
	const paneId = useMemo(
		() => (tabs ? (orchestratorPane(tabs)?.paneId ?? "") : ""),
		[tabs],
	);
	const status = usePaneStatus(paneId);
	const running = paneId !== "";
	return (
		<div
			className="flex items-center"
			style={{
				width: 240,
				height: 58,
				gap: 10,
				padding: "0 14px",
				borderRadius: 12,
				border: "1.5px solid var(--accent)",
				background:
					"color-mix(in srgb, var(--accent) 12%, var(--bg-secondary))",
				color: "var(--fg-primary)",
			}}
		>
			<Handle type="source" position={Position.Bottom} style={hiddenHandle} />
			<Handle
				id="side"
				type="source"
				position={Position.Right}
				style={hiddenHandle}
			/>
			<Handle
				id="side-in"
				type="target"
				position={Position.Right}
				style={hiddenHandle}
			/>
			<Network size={18} style={{ color: "var(--accent)" }} />
			<div className="flex flex-col min-w-0 flex-1">
				<span style={{ fontSize: 13, fontWeight: 600 }}>Orchestrator</span>
				<span
					className="truncate"
					style={{ fontSize: 11, color: "var(--fg-secondary)" }}
				>
					{running ? "Ask me below" : "Stopped"}
				</span>
			</div>
			{running ? (
				<AgentStatusIcon status={status} size={14} />
			) : (
				phase === "ready" && (
					<button
						type="button"
						className={`nodrag ${primaryButtonClass}`}
						style={{ height: 24, padding: "0 8px", fontSize: 11, gap: 4 }}
						title="Start the Orchestrator"
						onClick={() => void restartOrchestrator()}
					>
						<RefreshCw size={11} />
						Start
					</button>
				)
			)}
		</div>
	);
});

const WorkspaceNode = memo(function WorkspaceNode({
	data,
}: NodeProps<WorkspaceNodeT>) {
	const { ws } = data;
	const actions = useContext(ActionsContext);
	const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: right-click menu of a graph box
		<div
			className="w-full h-full"
			style={{
				borderRadius: 12,
				border: `1px ${ws.opened ? "solid" : "dashed"} var(--border)`,
				background: ws.opened
					? "color-mix(in srgb, var(--bg-secondary) 70%, transparent)"
					: "transparent",
				opacity: ws.opened ? 1 : 0.65,
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				setMenuAt({ x: e.clientX, y: e.clientY });
			}}
		>
			<Handle type="target" position={Position.Top} style={hiddenHandle} />
			<div
				className="truncate select-none"
				style={{
					height: 30,
					lineHeight: "30px",
					padding: "0 12px",
					fontSize: 12,
					fontWeight: 600,
					color: ws.opened ? "var(--fg-primary)" : "var(--fg-secondary)",
				}}
				title={ws.opened ? ws.name : `${ws.name} (not open)`}
			>
				{ws.name}
			</div>
			{menuAt && actions && (
				<PaneContextMenu
					x={menuAt.x}
					y={menuAt.y}
					onClose={() => setMenuAt(null)}
					items={[
						ws.opened
							? {
									label: "Close Workspace",
									onClick: () => actions.closeWorkspace(ws.id),
								}
							: {
									label: "Open Workspace",
									onClick: () => openInBackground(ws.id),
								},
						{ separator: true },
						{ label: "New agent…", onClick: () => actions.newAgentIn(ws.id) },
						{
							label: "New task…",
							onClick: () => openNewTask({ workspaceId: ws.id }),
						},
					]}
				/>
			)}
		</div>
	);
});

const AgentNode = memo(function AgentNode({
	data,
	selected,
}: NodeProps<AgentNodeT>) {
	const { agent, workspaceName, fresh } = data;
	const status = usePaneStatus(agent.dormant ? "" : agent.paneId);
	const liveHandle = useAgentHandle(agent.paneId);
	const handle = liveHandle ?? agent.handle;
	const agentName = useSettingsStore((s) =>
		agent.agentId
			? (s.agents.find((a) => a.id === agent.agentId)?.name ?? "Agent")
			: "Agent",
	);
	const progress = useAgentSignalsStore((s) => s.progress[agent.paneId]);
	const flag = useAgentSignalsStore((s) => s.flags[agent.paneId]);
	const Icon = (agent.agentId && getAgentIconComponent(agent.agentId)) || null;

	// A status change pulses the node once.
	const [pulse, setPulse] = useState(0);
	const prev = useRef(status);
	useEffect(() => {
		if (prev.current !== status) {
			prev.current = status;
			setPulse((n) => n + 1);
		}
	}, [status]);

	const name = handle ?? agentName;
	const label = `${name} (${workspaceName} · ${agent.tabName})`;
	const menu = useAgentMenu({
		paneId: agent.paneId,
		handle: liveHandle,
		label,
		extra: [
			{ label: "Peek", onClick: () => peekAgent(agent.paneId) },
			{
				label: "Ask the Orchestrator about it",
				onClick: () => {
					askOrchestrator(askAboutText(name, workspaceName));
				},
			},
		],
	});

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: right-click menu of a graph node */}
			<div
				key={pulse}
				className={`w-full h-full flex items-center select-none ${
					fresh ? "orch-node-in" : ""
				} ${pulse > 0 ? "orch-node-pulse" : ""}`}
				style={{
					gap: 8,
					padding: "0 10px",
					borderRadius: 9,
					cursor: "pointer",
					border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
					background: selected
						? "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))"
						: "var(--bg-primary)",
					opacity: agent.dormant ? 0.6 : 1,
					boxShadow: selected
						? "0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)"
						: undefined,
				}}
				title={[label, progress, flag ? `Wants you: ${flag.message}` : ""]
					.filter(Boolean)
					.join("\n")}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					if (!agent.dormant) menu.open(e.clientX, e.clientY);
				}}
			>
				<Handle type="target" position={Position.Top} style={hiddenHandle} />
				<Handle
					id="side"
					type="source"
					position={Position.Right}
					style={hiddenHandle}
				/>
				<Handle
					id="side-in"
					type="target"
					position={Position.Left}
					style={hiddenHandle}
				/>
				{agent.dormant ? (
					<AgentStatusIcon status="grey" size={12} />
				) : (
					<AgentStatusIcon status={status} size={12} />
				)}
				<span style={{ color: "var(--fg-secondary)", display: "flex" }}>
					{Icon ? <Icon size={14} /> : <FallbackAgentIcon size={13} />}
				</span>
				<span className="flex flex-col min-w-0 flex-1">
					<span className="flex items-center min-w-0" style={{ gap: 5 }}>
						<span
							className="truncate"
							style={{ fontSize: 12.5, color: "var(--fg-primary)" }}
						>
							{name}
						</span>
						{flag && (
							<span style={{ color: "var(--warning)", display: "flex" }}>
								<BellRing size={11} />
							</span>
						)}
					</span>
					<span
						className="truncate"
						style={{ fontSize: 11, color: "var(--fg-secondary)" }}
					>
						{agent.dormant
							? "Not running"
							: (progress ?? `${agentName} · ${agent.tabName}`)}
					</span>
				</span>
			</div>
			{menu.element}
		</>
	);
});

const NODE_TYPES = {
	orchestrator: OrchestratorNode,
	workspace: WorkspaceNode,
	agent: AgentNode,
};

/** A single click on a greyed Agent: it is not running; offer to start its
 *  Workspace (in the background, as the Fleet Console's Relaunch does). */
function DormantCard({
	agent,
	x,
	y,
	onClose,
}: {
	agent: GraphAgent;
	x: number;
	y: number;
	onClose: () => void;
}) {
	const ws = useWorkspaceStore((s) =>
		s.workspaces.find((w) => w.id === agent.workspaceId),
	);
	const name = agent.handle ?? "This agent";
	return (
		<div
			className="fixed flex flex-col"
			style={{
				left: x + 8,
				top: y + 8,
				zIndex: 60,
				gap: 8,
				width: 260,
				padding: "12px 14px",
				borderRadius: 10,
				border: "1px solid var(--border)",
				background: "var(--bg-secondary)",
				boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
				fontSize: 12,
				color: "var(--fg-secondary)",
			}}
		>
			<span>
				<strong style={{ color: "var(--fg-primary)" }}>{name}</strong> in{" "}
				{ws?.name ?? "its workspace"} is not running.
			</span>
			<div className="flex" style={{ gap: 8 }}>
				<button
					type="button"
					className={primaryButtonClass}
					style={{ height: 26, padding: "0 10px", fontSize: 12 }}
					onClick={() => {
						openInBackground(agent.workspaceId);
						onClose();
					}}
				>
					Start its workspace
				</button>
				<button
					type="button"
					className="text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
					style={{ height: 26, padding: "0 8px", fontSize: 12 }}
					onClick={onClose}
				>
					Not now
				</button>
			</div>
		</div>
	);
}
