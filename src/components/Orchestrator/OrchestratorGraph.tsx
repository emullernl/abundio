import "@xyflow/react/dist/style.css";
import {
	type Edge,
	type EdgeProps,
	Handle,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	useReactFlow,
} from "@xyflow/react";
import { BellRing, Network, Plus, RefreshCw } from "lucide-react";
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
	runningControlActivity,
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
	type Container,
	type GraphAgent,
	graphModel,
	layoutGraph,
	type Placed,
	type Point,
	polylinePath,
	routeBetween,
} from "../../lib/orchestratorGraph";
import { restartOrchestrator } from "../../lib/orchestratorSession";
import { toggleOrchestratorFileSearch } from "../../lib/orchestratorTabs";
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
import { primaryButtonClass } from "../PromptActions/fieldStyles";
import { useAgentMenu } from "../Sidebar/useAgentMenu";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";

/** How long a finished call's stream takes to fade. */
const FADE_MS = 700;

const ORCH = "orchestrator";
const ORCH_NODE = "orchestrator";
const agentNodeId = (paneId: string) => `agent:${paneId}`;
const containerNodeId = (id: string) => `box:${id}`;

/** A pane in the chart's terms: the Orchestrator, or its pane id. */
const routeKey = (paneId: string, orchestratorPaneId: string | null) =>
	paneId === orchestratorPaneId ? ORCH : paneId;
const nodeOf = (key: string) => (key === ORCH ? ORCH_NODE : agentNodeId(key));

type AgentData = {
	agent: GraphAgent;
	workspaceName: string;
	fresh: boolean;
	receiving: boolean;
};
type ContainerData = {
	/** A Workspace's id, or null for the Orchestrator's own helpers. */
	workspaceId: string | null;
	name: string;
	count: number;
};
type OrchData = { receiving: boolean };
type WireData = { points: Point[] };
type StreamData = {
	points: Point[];
	kind: "read" | "act";
	ending: boolean;
};

/** What a node can ask the graph to do. */
interface GraphActions {
	closeWorkspace: (workspaceId: string) => void;
	newAgentIn: (workspaceId: string) => void;
}
const ActionsContext = createContext<GraphActions | null>(null);

/** Edges are drawn from the layout's own routes; React Flow still wants a
 *  handle on each end, so every node gets a hidden one. */
const hiddenHandle = {
	opacity: 0,
	width: 1,
	height: 1,
	minWidth: 0,
	minHeight: 0,
	border: "none",
};
function HiddenHandles() {
	return (
		<>
			<Handle type="source" position={Position.Right} style={hiddenHandle} />
			<Handle type="target" position={Position.Left} style={hiddenHandle} />
		</>
	);
}

/** React Flow places a node by its top-left corner; the layout gives centres. */
const corner = (p: Placed) => ({ x: p.x - p.width / 2, y: p.y - p.height / 2 });

function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * The **Orchestrator view**'s graph (ADR-0057): a horizontal organisation
 * chart. The Orchestrator on the left; one container per Opened workspace
 * to its right, its Agents in a row inside; elbow lines between them. Single
 * click peeks, double click is **Switch to**, right click opens the Agent
 * menu (or, on a container, the Workspace's). While one pane's Agent control
 * call to another runs, comets flow from one to the other along the lines.
 */
export function OrchestratorGraph() {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const facts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const opened = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const panePtyMap = usePtyActivityStore((s) => s.panePtyMap);
	const activities = usePtyActivityStore((s) => s.activities);
	const orchestratorWsId = useOrchestratorStore((s) => s.workspaceId);
	const selected = useOrchestratorStore((s) => s.selectedPaneId);

	const orchestratorPaneId = useMemo(() => {
		const ws = workspaces.find((w) => w.id === orchestratorWsId);
		return ws ? (orchestratorPane(ws.tabs)?.paneId ?? null) : null;
	}, [workspaces, orchestratorWsId]);

	// Which PTYs are in agent mode changes far less often than activities do:
	// key the model on that, not on every status tick.
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
			orchestratorPaneId,
		});
	}, [workspaces, facts, opened, panePtyMap, agentPtyKey, orchestratorPaneId]);
	const layout = useMemo(() => layoutGraph(model), [model]);

	// Agents that appear after the graph first drew grow in (spawned).
	const known = useRef<Set<string> | null>(null);
	const fresh = useMemo(() => {
		const ids = [
			...model.workspaces.flatMap((w) => w.agents.map((a) => a.paneId)),
			...model.helpers.map((h) => h.paneId),
		];
		if (known.current === null) {
			known.current = new Set(ids);
			return new Set<string>();
		}
		const now = new Set(ids.filter((id) => !known.current?.has(id)));
		for (const id of ids) known.current.add(id);
		return now;
	}, [model]);

	// ── Calls running now, plus the ones fading out ──
	const [calls, setCalls] = useState<
		Map<number, { call: ControlActivity; ending: boolean }>
	>(
		() =>
			new Map(
				runningControlActivity().map((c) => [c.id, { call: c, ending: false }]),
			),
	);
	useEffect(() => {
		const timers = new Set<ReturnType<typeof setTimeout>>();
		const stop = subscribeControlActivity((e) => {
			if (e.type === "start") {
				setCalls((m) =>
					new Map(m).set(e.call.id, { call: e.call, ending: false }),
				);
				return;
			}
			setCalls((m) => {
				const entry = m.get(e.id);
				if (!entry) return m;
				return new Map(m).set(e.id, { ...entry, ending: true });
			});
			const t = setTimeout(() => {
				timers.delete(t);
				setCalls((m) => {
					const next = new Map(m);
					next.delete(e.id);
					return next;
				});
			}, FADE_MS);
			timers.add(t);
		});
		return () => {
			stop();
			for (const t of timers) clearTimeout(t);
		};
	}, []);

	const receiving = useMemo(() => {
		const set = new Set<string>();
		for (const { call, ending } of calls.values()) {
			if (!ending) {
				set.add(nodeOf(routeKey(call.targetPaneId, orchestratorPaneId)));
			}
		}
		return set;
	}, [calls, orchestratorPaneId]);

	const nodes = useMemo(() => {
		const out: Node[] = [];
		const box = (id: string, c: Container, data: ContainerData): Node => ({
			id: containerNodeId(id),
			type: "container",
			position: corner(c),
			style: { width: c.width, height: c.height },
			data,
			draggable: false,
			selectable: false,
			zIndex: -1,
		});
		for (const ws of model.workspaces) {
			out.push(
				box(ws.id, layout.containers[ws.id], {
					workspaceId: ws.id,
					name: ws.name,
					count: ws.agents.length,
				}),
			);
		}
		if (layout.helperContainer) {
			out.push(
				box("orchestrator-helpers", layout.helperContainer, {
					workspaceId: null,
					name: "Orchestrator's helpers",
					count: model.helpers.length,
				}),
			);
		}
		out.push(
			{
				id: ORCH_NODE,
				type: "orchestrator",
				position: corner(layout.orchestrator),
				data: { receiving: receiving.has(ORCH_NODE) } satisfies OrchData,
				draggable: false,
				selectable: false,
			},
			{
				id: "add",
				type: "add",
				position: corner(layout.add),
				data: {},
				draggable: false,
				selectable: false,
			},
		);
		const agentNode = (agent: GraphAgent, workspaceName: string): Node => {
			const p = layout.agents[agent.paneId];
			return {
				id: agentNodeId(agent.paneId),
				type: "agent",
				position: corner(p),
				style: { width: p.width, height: p.height },
				data: {
					agent,
					workspaceName,
					fresh: fresh.has(agent.paneId),
					receiving: receiving.has(agentNodeId(agent.paneId)),
				} satisfies AgentData,
				draggable: false,
				selected: agent.paneId === selected,
			};
		};
		for (const ws of model.workspaces) {
			for (const a of ws.agents) out.push(agentNode(a, ws.name));
		}
		for (const h of model.helpers) out.push(agentNode(h, "Orchestrator"));
		return out;
	}, [model, layout, fresh, selected, receiving]);

	const edges = useMemo(() => {
		const out: Edge[] = [];
		// The chart's lines: the route from the Orchestrator to every Agent.
		// Routes share their trunk and buses, which then draw on top of each
		// other in one solid colour.
		for (const id of Object.keys(layout.agents)) {
			const points = routeBetween(layout, ORCH, id);
			if (!points) continue;
			out.push({
				id: `wire:${id}`,
				source: ORCH_NODE,
				target: agentNodeId(id),
				type: "wire",
				data: { points } satisfies WireData,
			});
		}
		for (const { call, ending } of calls.values()) {
			const from = routeKey(call.callerPaneId, orchestratorPaneId);
			const to = routeKey(call.targetPaneId, orchestratorPaneId);
			const points = routeBetween(layout, from, to);
			if (!points) continue;
			out.push({
				id: `call:${call.id}`,
				source: nodeOf(from),
				target: nodeOf(to),
				type: "stream",
				// Above the containers and the lines.
				zIndex: 1000,
				data: { points, kind: call.kind, ending } satisfies StreamData,
			});
		}
		return out;
	}, [layout, calls, orchestratorPaneId]);

	// ── Graph-level dialogs ──
	const [newAgentWs, setNewAgentWs] = useState<string | null>(null);
	const { requestClose, dialogProps } = useConfirmCloseWorkspace();
	const actions = useMemo<GraphActions>(
		() => ({ closeWorkspace: requestClose, newAgentIn: setNewAgentWs }),
		[requestClose],
	);

	return (
		<ActionsContext.Provider value={actions}>
			<div className="absolute inset-0 orch-graph">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={NODE_TYPES}
					edgeTypes={EDGE_TYPES}
					fitView
					fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }}
					minZoom={0.15}
					maxZoom={1.6}
					nodesDraggable={false}
					nodesConnectable={false}
					elementsSelectable
					zoomOnDoubleClick={false}
					onNodeClick={(_, node) => {
						if (node.type === "agent") {
							peekAgent((node.data as AgentData).agent.paneId);
						}
					}}
					onNodeDoubleClick={(_, node) => {
						if (node.type === "agent") {
							switchToPane((node.data as AgentData).agent.paneId);
						}
					}}
					onPaneClick={() =>
						useOrchestratorStore.getState().set({ selectedPaneId: null })
					}
				>
					<FitOnChange count={nodes.length} />
				</ReactFlow>
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

/** Re-fits the view when Agents come or go, and when the graph's area is
 *  resized (the divider, the window), so the chart always fills it. */
function FitOnChange({ count }: { count: number }) {
	const flow = useReactFlow();
	const first = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-fit whenever the node count changes
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		const id = requestAnimationFrame(() =>
			flow.fitView({ padding: 0.08, maxZoom: 1.1, duration: 300 }),
		);
		return () => cancelAnimationFrame(id);
	}, [count, flow]);
	useEffect(() => {
		const el = document.querySelector(".orch-graph");
		if (!el || typeof ResizeObserver === "undefined") return;
		let frame = 0;
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() =>
				flow.fitView({ padding: 0.08, maxZoom: 1.1 }),
			);
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [flow]);
	return null;
}

// ── Nodes ──

/** A Workspace's container (or the Orchestrator's helpers'): its name in
 *  the top-left corner. Right click on a Workspace opens its menu. */
const ContainerNode = memo(function ContainerNode({
	data,
}: NodeProps<Node<ContainerData>>) {
	const { workspaceId, name, count } = data;
	const actions = useContext(ActionsContext);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: right-click menu of a Workspace container */}
			<div
				className="w-full h-full select-none"
				style={{
					borderRadius: 12,
					border:
						"1px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
					// Darker than the view behind it, so the Agents' pills stand out.
					background: "color-mix(in srgb, var(--bg-primary) 82%, #000)",
				}}
				title={`${name} · ${count} agent${count === 1 ? "" : "s"}`}
				onContextMenu={(e) => {
					if (!workspaceId) return;
					e.preventDefault();
					e.stopPropagation();
					setMenu({ x: e.clientX, y: e.clientY });
				}}
			>
				<HiddenHandles />
				<div
					className="flex items-center truncate"
					style={{
						height: 24,
						padding: "0 12px",
						gap: 6,
						fontSize: 12,
						fontWeight: 600,
						color: "var(--fg-primary)",
					}}
				>
					<span className="truncate">{name}</span>
					<span
						style={{
							fontSize: 10.5,
							fontWeight: 400,
							color: "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
						}}
					>
						{count}
					</span>
				</div>
			</div>
			{menu && actions && workspaceId && (
				<PaneContextMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					items={[
						{
							label: "Open file…",
							onClick: () => toggleOrchestratorFileSearch([workspaceId]),
						},
						{ separator: true },
						{
							label: "New agent…",
							onClick: () => actions.newAgentIn(workspaceId),
						},
						{
							label: "New task…",
							onClick: () => openNewTask({ workspaceId }),
						},
						{ separator: true },
						{
							label: "Close Workspace",
							onClick: () => actions.closeWorkspace(workspaceId),
						},
					]}
				/>
			)}
		</>
	);
});

const OrchestratorNode = memo(function OrchestratorNode({
	data,
}: NodeProps<Node<OrchData>>) {
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
			className={`flex items-center ${data.receiving ? "orch-node-receiving" : ""}`}
			style={{
				width: 210,
				height: 56,
				gap: 10,
				padding: "0 14px",
				borderRadius: 28,
				border: "1.5px solid var(--accent)",
				background:
					"color-mix(in srgb, var(--accent) 14%, var(--bg-secondary))",
				color: "var(--fg-primary)",
			}}
		>
			<HiddenHandles />
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

/** "Open workspace…": right below the Orchestrator. */
const AddNode = memo(function AddNode() {
	return (
		<button
			type="button"
			className="nodrag flex items-center justify-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:border-[var(--accent)] border border-dashed border-[var(--border)]"
			style={{
				width: 150,
				height: 34,
				gap: 6,
				borderRadius: 17,
				fontSize: 12,
				background: "var(--bg-primary)",
				cursor: "pointer",
			}}
			title="Open a workspace — its agents join the graph"
			onClick={() =>
				useOrchestratorStore.getState().set({ workspacePickerOpen: true })
			}
		>
			<Plus size={13} />
			Open workspace…
		</button>
	);
});

const AgentNode = memo(function AgentNode({
	data,
	selected,
}: NodeProps<Node<AgentData>>) {
	const { agent, workspaceName, fresh, receiving } = data;
	const status = usePaneStatus(agent.paneId);
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
				} ${pulse > 0 ? "orch-node-pulse" : ""} ${
					receiving ? "orch-node-receiving" : ""
				}`}
				style={{
					gap: 6,
					padding: "0 10px 0 8px",
					borderRadius: 999,
					cursor: "pointer",
					border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
					// A raised surface, lighter than the container it sits in.
					background: selected
						? "color-mix(in srgb, var(--accent) 16%, var(--bg-tertiary))"
						: "var(--bg-tertiary)",
					boxShadow: selected
						? "0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)"
						: undefined,
				}}
				title={[
					name,
					`${agentName} · ${workspaceName} · ${agent.tabName}`,
					progress,
					flag ? `Wants you: ${flag.message}` : "",
				]
					.filter(Boolean)
					.join("\n")}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					menu.open(e.clientX, e.clientY);
				}}
			>
				<HiddenHandles />
				<AgentStatusIcon status={status} size={12} />
				<span style={{ color: "var(--fg-secondary)", display: "flex" }}>
					{Icon ? <Icon size={14} /> : <FallbackAgentIcon size={13} />}
				</span>
				<span
					className="truncate flex-1 min-w-0"
					style={{ fontSize: 12.5, color: "var(--fg-primary)" }}
				>
					{name}
				</span>
				{flag && (
					<span style={{ color: "var(--warning)", display: "flex" }}>
						<BellRing size={11} />
					</span>
				)}
			</div>
			{menu.element}
		</>
	);
});

const NODE_TYPES = {
	container: ContainerNode,
	orchestrator: OrchestratorNode,
	add: AddNode,
	agent: AgentNode,
};

// ── Edges ──

/** The chart's lines: one route from the Orchestrator to an Agent. */
function WireEdge({ data }: EdgeProps<Edge<WireData>>) {
	if (!data) return null;
	return (
		<path
			d={polylinePath(data.points)}
			style={{
				fill: "none",
				stroke: "color-mix(in srgb, var(--accent) 30%, var(--bg-primary))",
				strokeWidth: 1.4,
				strokeLinejoin: "round",
			}}
		/>
	);
}

/** How many comets flow along a stream at once, and their speed. */
const PARTICLES = 6;
const SPEED_PX_S = 420;
/** A comet's head, then its tail just behind it (seconds behind). */
const TAIL = [0, 0.04, 0.08];

/** Length of a route of right angles. */
function routeLength(points: readonly Point[]): number {
	let n = 0;
	for (let i = 1; i < points.length; i++) {
		n += Math.hypot(
			points[i].x - points[i - 1].x,
			points[i].y - points[i - 1].y,
		);
	}
	return n;
}

/**
 * A running Agent control call: comets flowing from caller to target along
 * the chart's own lines, the route lit beneath them. Fades out when the call
 * ends; the lit route alone with reduced motion.
 */
function StreamEdge({ data }: EdgeProps<Edge<StreamData>>) {
	if (!data) return null;
	const act = data.kind !== "read";
	const color = act ? "var(--accent)" : "var(--fg-secondary)";
	const d = polylinePath(data.points);
	// The same speed on every route, so a long route is not a blur.
	const lap = Math.max(0.8, routeLength(data.points) / SPEED_PX_S);
	const still = prefersReducedMotion();
	const comets = still ? [] : Array.from({ length: PARTICLES }, (_, i) => i);
	return (
		<g
			className="orch-stream"
			style={{
				opacity: data.ending ? 0 : 1,
				transition: `opacity ${FADE_MS}ms ease`,
			}}
		>
			<path
				d={d}
				style={{
					fill: "none",
					stroke: color,
					strokeOpacity: still ? 0.9 : 0.35,
					strokeWidth: act ? 2.4 : 1.8,
					strokeLinejoin: "round",
					strokeDasharray: act ? undefined : "3 5",
				}}
			/>
			{comets.map((i) =>
				TAIL.map((lag, j) => (
					<circle
						key={`${i}-${lag}`}
						r={(act ? 3.4 : 2.6) * (1 - j * 0.28)}
						style={{
							fill: color,
							opacity: 1 - j * 0.3,
							filter: j === 0 ? `drop-shadow(0 0 4px ${color})` : undefined,
						}}
					>
						<animateMotion
							dur={`${lap}s`}
							repeatCount="indefinite"
							begin={`${-(i * lap) / PARTICLES - lag}s`}
							path={d}
						/>
					</circle>
				)),
			)}
		</g>
	);
}

const EDGE_TYPES = { wire: WireEdge, stream: StreamEdge };
