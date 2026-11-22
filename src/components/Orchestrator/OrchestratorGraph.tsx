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
	ViewportPortal,
} from "@xyflow/react";
import { BellRing, Network, Plus, RefreshCw } from "lucide-react";
import {
	type CSSProperties,
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
import { FADE_MS } from "../../lib/callStreams";
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
	HOST_LINE,
	layoutGraph,
	nodeFrame,
	type Point,
	polylinePath,
	routeBetween,
	routeLength,
	travelKeyframes,
} from "../../lib/orchestratorGraph";
import { restartOrchestrator } from "../../lib/orchestratorSession";
import { toggleOrchestratorFileSearch } from "../../lib/orchestratorTabs";
import { switchToPane } from "../../lib/paneLocation";
import {
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import {
	selectReceiving,
	useCallStreamsStore,
} from "../../stores/callStreamsStore";
import { useAllAgents } from "../../stores/hostAgentsStore";
import { useJoinedStore } from "../../stores/joinedStore";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { NewAgentDialog } from "../FleetConsole/NewAgentDialog";
import { primaryButtonClass } from "../PromptActions/fieldStyles";
import { useAgentMenu } from "../Sidebar/useAgentMenu";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";

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
};
type ContainerData = {
	/** A Workspace's id, or null for the Orchestrator's own helpers. */
	workspaceId: string | null;
	name: string;
	/** A joined Workspace's Host, on a line of its own under the name. */
	host?: string;
	count: number;
};
type WireData = { points: Point[] };
type StreamData = {
	points: Point[];
	kind: "read" | "act";
	fading: boolean;
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
	const joinedEntries = useJoinedStore((s) => s.entries);
	const model = useMemo(() => {
		const agentPtys = new Set(agentPtyKey ? agentPtyKey.split(",") : []);
		return graphModel({
			workspaces,
			order: flattenRowsToIds(buildWorkspaceRows(workspaces, facts)),
			openedWorkspaceIds: opened,
			panePtyMap,
			isAgentPty: (p) => agentPtys.has(p),
			orchestratorPaneId,
			// Joined Workspaces' clusters say which Host they run on.
			hostNameOf: (id) => {
				const host = workspaces.find((w) => w.id === id)?.joined?.hostId;
				return host
					? (joinedEntries.find((e) => e.hostId === host)?.hostName ?? host)
					: null;
			},
		});
	}, [
		workspaces,
		facts,
		opened,
		panePtyMap,
		agentPtyKey,
		orchestratorPaneId,
		joinedEntries,
	]);
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

	// The streams: calls running now, plus the ones still showing or fading.
	const streams = useCallStreamsStore((s) => s.streams);

	const nodes = useMemo(() => {
		const out: Node[] = [];
		const box = (id: string, c: Container, data: ContainerData): Node => ({
			id: containerNodeId(id),
			type: "container",
			...nodeFrame(c),
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
					...(ws.host ? { host: ws.host } : {}),
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
				...nodeFrame(layout.orchestrator),
				data: {},
				draggable: false,
				selectable: false,
			},
			{
				id: "add",
				type: "add",
				...nodeFrame(layout.add),
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
				...nodeFrame(p),
				data: {
					agent,
					workspaceName,
					fresh: fresh.has(agent.paneId),
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
	}, [model, layout, fresh, selected]);

	const wires = useMemo(() => {
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
		return out;
	}, [layout]);

	const streamEdges = useMemo(() => {
		const out: (Edge & { data: StreamData })[] = [];
		for (const { call, fading } of streams.values()) {
			const from = routeKey(call.callerPaneId, orchestratorPaneId);
			const to = routeKey(call.targetPaneId, orchestratorPaneId);
			const points = routeBetween(layout, from, to);
			if (!points) continue;
			out.push({
				id: `call:${call.id}`,
				source: nodeOf(from),
				target: nodeOf(to),
				type: "stream",
				// On the edge's group; the fade is on its wrapper (globals.css).
				className: fading ? "orch-stream-fading" : undefined,
				// Above the containers and the lines.
				zIndex: 1000,
				data: { points, kind: call.kind, fading },
			});
		}
		return out;
	}, [layout, streams, orchestratorPaneId]);

	const edges = useMemo(() => [...wires, ...streamEdges], [wires, streamEdges]);

	// The travelling lights, one per lit stream (gone once it fades).
	const lights = useMemo(
		() =>
			streamEdges.flatMap((e) =>
				e.data.fading ? [] : [{ id: e.id, ...e.data }],
			),
		[streamEdges],
	);

	// ── Graph-level dialogs ──
	const [newAgentWs, setNewAgentWs] = useState<string | null>(null);
	const { requestClose, dialogProps } = useConfirmCloseWorkspace();
	const actions = useMemo<GraphActions>(
		() => ({ closeWorkspace: requestClose, newAgentIn: setNewAgentWs }),
		[requestClose],
	);

	return (
		<ActionsContext.Provider value={actions}>
			<div
				className="absolute inset-0 orch-graph"
				// The streams' fade (globals.css) takes its length from FADE_MS.
				style={{ "--orch-fade": `${FADE_MS}ms` } as CSSProperties}
			>
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
					{!prefersReducedMotion() && (
						<ViewportPortal>
							{lights.map((l) => (
								<CallLight key={l.id} points={l.points} kind={l.kind} />
							))}
						</ViewportPortal>
					)}
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

/** Whether the graph's area has a size: a fit of an area with none (hidden
 *  for a moment, or not laid out yet) moves the chart off-screen, and the
 *  graph would show blank until the next fit. */
function graphHasSize(): boolean {
	const el = document.querySelector(".orch-graph");
	return !!el && el.clientWidth > 0 && el.clientHeight > 0;
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
		const id = requestAnimationFrame(() => {
			if (graphHasSize()) {
				flow.fitView({ padding: 0.08, maxZoom: 1.1, duration: 300 });
			}
		});
		return () => cancelAnimationFrame(id);
	}, [count, flow]);
	useEffect(() => {
		const el = document.querySelector(".orch-graph");
		if (!el || typeof ResizeObserver === "undefined") return;
		let frame = 0;
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (graphHasSize()) flow.fitView({ padding: 0.08, maxZoom: 1.1 });
			});
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
	const { workspaceId, name, host, count } = data;
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
				title={`${name}${host ? ` on ${host}` : ""} · ${count} agent${count === 1 ? "" : "s"}`}
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
				{host && (
					<div
						className="truncate"
						style={{
							height: HOST_LINE,
							marginTop: -4,
							padding: "0 12px",
							fontSize: 10.5,
							lineHeight: `${HOST_LINE}px`,
							color: "var(--fg-secondary)",
						}}
					>
						☁ {host}
					</div>
				)}
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
	const receiving = useCallStreamsStore(selectReceiving(paneId || null));
	return (
		<div
			className={`flex items-center ${receiving ? "orch-node-receiving" : ""}`}
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
	const { agent, workspaceName, fresh } = data;
	const status = usePaneStatus(agent.paneId);
	const receiving = useCallStreamsStore(selectReceiving(agent.paneId));
	const liveHandle = useAgentHandle(agent.paneId);
	const handle = liveHandle ?? agent.handle;
	const known = useAllAgents();
	const agentName = agent.agentId
		? (known.find((a) => a.id === agent.agentId)?.name ?? "Agent")
		: "Agent";
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

/** How fast a call's light travels, and the shortest lap. */
const SPEED_PX_S = 380;
const MIN_LAP_S = 0.9;
/** The light's head, its halo, and the two tail dots behind it (ms). */
const LIGHT_PARTS = [
	{ size: 18, opacity: 0.3, lagMs: 0 },
	{ size: 7, opacity: 1, lagMs: 0 },
	{ size: 5, opacity: 0.55, lagMs: 45 },
	{ size: 3.5, opacity: 0.3, lagMs: 90 },
];

/**
 * A running call's light, travelling its route from caller to target with a
 * halo and a short tail: small HTML dots in the graph's own coordinates
 * (React Flow's viewport portal), moved by a `transform` animation.
 *
 * Not SVG: animating anything drawn in the edges' SVG (SMIL motion, CSS
 * filters, a moving dash) makes WebKit, the app's webview, repaint that
 * whole layer every frame, which showed as a flickering redraw, froze the
 * status icons, and now and then left the graph blank. A transform
 * animation runs on the compositor and repaints nothing.
 */
function CallLight({
	points,
	kind,
}: {
	points: readonly Point[];
	kind: "read" | "act";
}) {
	const refs = useRef<(HTMLDivElement | null)[]>([]);
	const key = points.map((p) => `${p.x},${p.y}`).join(" ");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `points`
	useEffect(() => {
		const frames = travelKeyframes(points);
		const lap = Math.max(MIN_LAP_S, routeLength(points) / SPEED_PX_S) * 1000;
		const running = refs.current.flatMap((el, i) =>
			el?.animate
				? [
						el.animate(frames, {
							duration: lap,
							iterations: Number.POSITIVE_INFINITY,
							easing: "cubic-bezier(0.45, 0.05, 0.55, 0.95)",
							delay: LIGHT_PARTS[i].lagMs,
							fill: "backwards",
						}),
					]
				: [],
		);
		return () => {
			for (const a of running) a.cancel();
		};
	}, [key]);
	const color =
		kind === "act"
			? "color-mix(in srgb, var(--accent) 45%, var(--fg-primary))"
			: "var(--fg-secondary)";
	return (
		<>
			{LIGHT_PARTS.map((part, i) => (
				<div
					key={`${part.size}-${part.lagMs}`}
					ref={(el) => {
						refs.current[i] = el;
					}}
					className="orch-light"
					style={{
						width: part.size,
						height: part.size,
						marginLeft: -part.size / 2,
						marginTop: -part.size / 2,
						opacity: part.opacity,
						background:
							i === 0
								? `radial-gradient(circle, ${color} 0%, transparent 70%)`
								: color,
					}}
				/>
			))}
		</>
	);
}

/**
 * A running Agent control call, after the organisation chart of Abundia in
 * the theme's colours: the route lit with a gradient that brightens toward
 * the target, over a soft glow. Static: the light that travels it is
 * `CallLight`. Fades out when the stream ends: the fade is on React Flow's
 * own `<svg>` around the edge (globals.css), an HTML box the compositor can
 * fade, never on anything inside the SVG, which WebKit would repaint every
 * frame.
 */
function StreamEdge({ id, data }: EdgeProps<Edge<StreamData>>) {
	if (!data || data.points.length < 2) return null;
	const act = data.kind !== "read";
	const d = polylinePath(data.points);
	const from = data.points[0];
	const to = data.points[data.points.length - 1];
	const gradientId = `orch-grad-${id}`;
	const stroke = act ? `url(#${gradientId})` : "var(--fg-secondary)";
	return (
		<g className="orch-stream">
			{act && (
				<defs>
					{/* userSpaceOnUse: a straight line has a zero-width box, which a
					    bounding-box gradient cannot fill. */}
					<linearGradient
						id={gradientId}
						gradientUnits="userSpaceOnUse"
						x1={from.x}
						y1={from.y}
						x2={to.x}
						y2={to.y}
					>
						<stop
							offset="0%"
							style={{
								stopColor:
									"color-mix(in srgb, var(--accent) 40%, var(--bg-primary))",
							}}
						/>
						<stop offset="55%" style={{ stopColor: "var(--accent)" }} />
						<stop
							offset="100%"
							style={{
								stopColor:
									"color-mix(in srgb, var(--accent-hover) 60%, var(--fg-primary))",
							}}
						/>
					</linearGradient>
				</defs>
			)}
			{/* The glow: a wide, faint copy of the lit route. */}
			<path
				d={d}
				style={{
					fill: "none",
					stroke,
					strokeWidth: act ? 8 : 6,
					strokeOpacity: 0.16,
					strokeLinejoin: "round",
					strokeLinecap: "round",
				}}
			/>
			<path
				d={d}
				style={{
					fill: "none",
					stroke,
					strokeWidth: act ? 2.2 : 1.6,
					strokeLinejoin: "round",
					strokeDasharray: act ? undefined : "3 5",
				}}
			/>
		</g>
	);
}

const EDGE_TYPES = { wire: WireEdge, stream: StreamEdge };
