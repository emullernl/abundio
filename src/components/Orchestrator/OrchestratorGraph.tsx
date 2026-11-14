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
	type GraphAgent,
	graphModel,
	layoutGraph,
	type Petal,
	type Placed,
	petalPath,
	streamPath,
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
import { primaryButtonClass } from "../PromptActions/fieldStyles";
import { useAgentMenu } from "../Sidebar/useAgentMenu";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";

/** How long a finished call's stream takes to fade. */
const FADE_MS = 700;

const ORCH_NODE = "orchestrator";
const agentNodeId = (paneId: string) => `agent:${paneId}`;

type AgentData = {
	agent: GraphAgent;
	workspaceName: string;
	fresh: boolean;
	receiving: boolean;
	small: boolean;
};
type PetalsData = { petals: Petal[]; radius: number };
type OrchData = { receiving: boolean };
type StreamData = { kind: "read" | "act"; ending: boolean };

/** What a node can ask the graph to do. */
interface GraphActions {
	closeWorkspace: (workspaceId: string) => void;
	newAgentIn: (workspaceId: string) => void;
}
const ActionsContext = createContext<GraphActions | null>(null);

/** Edges start and end at a node's centre: one hidden handle each way. */
const centreHandle = {
	opacity: 0,
	width: 1,
	height: 1,
	minWidth: 0,
	minHeight: 0,
	left: "50%",
	top: "50%",
	transform: "translate(-50%, -50%)",
	border: "none",
};
function CentreHandles() {
	return (
		<>
			<Handle type="source" position={Position.Top} style={centreHandle} />
			<Handle type="target" position={Position.Top} style={centreHandle} />
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
 * The **Orchestrator view**'s graph (ADR-0057): a flower with the
 * Orchestrator in the centre and one petal per Opened workspace, its Agents
 * on it. Single click peeks, double click is **Switch to**, right click opens
 * the Agent menu (or, on a petal, the Workspace's). While one pane's Agent
 * control call to another runs, a comet stream flows between them.
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
			...model.petals.flatMap((w) => w.agents.map((a) => a.paneId)),
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
			if (ending) continue;
			set.add(
				call.targetPaneId === orchestratorPaneId
					? ORCH_NODE
					: agentNodeId(call.targetPaneId),
			);
		}
		return set;
	}, [calls, orchestratorPaneId]);

	const radius = Math.max(
		...layout.petals.map((p) => p.outer + 80),
		Math.hypot(layout.add.x, layout.add.y) + 120,
	);

	const nodes = useMemo(() => {
		const out: Node[] = [
			{
				id: "petals",
				type: "petals",
				position: { x: -radius, y: -radius },
				style: { width: radius * 2, height: radius * 2 },
				data: { petals: layout.petals, radius } satisfies PetalsData,
				draggable: false,
				selectable: false,
				zIndex: -1,
			},
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
		];
		const agentNode = (
			agent: GraphAgent,
			p: Placed,
			workspaceName: string,
			small: boolean,
		): Node => ({
			id: agentNodeId(agent.paneId),
			type: "agent",
			position: corner(p),
			style: { width: p.width, height: p.height },
			data: {
				agent,
				workspaceName,
				fresh: fresh.has(agent.paneId),
				receiving: receiving.has(agentNodeId(agent.paneId)),
				small,
			} satisfies AgentData,
			draggable: false,
			selected: agent.paneId === selected,
		});
		for (const ws of model.petals) {
			for (const a of ws.agents) {
				out.push(agentNode(a, layout.agents[a.paneId], ws.name, false));
			}
		}
		for (const h of model.helpers) {
			out.push(agentNode(h, layout.helpers[h.paneId], "Orchestrator", true));
		}
		return out;
	}, [model, layout, fresh, selected, receiving, radius]);

	const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
	const edges = useMemo(() => {
		const endpoint = (paneId: string) =>
			paneId === orchestratorPaneId ? ORCH_NODE : agentNodeId(paneId);
		const out: Edge[] = [];
		// Faint stems: the Orchestrator to each Agent, an Agent to its helpers.
		for (const ws of model.petals) {
			for (const a of ws.agents) {
				out.push({
					id: `stem:${a.paneId}`,
					source: a.spawnedBy ? agentNodeId(a.spawnedBy) : ORCH_NODE,
					target: agentNodeId(a.paneId),
					type: "stem",
				});
			}
		}
		for (const h of model.helpers) {
			out.push({
				id: `stem:${h.paneId}`,
				source: ORCH_NODE,
				target: agentNodeId(h.paneId),
				type: "stem",
			});
		}
		for (const { call, ending } of calls.values()) {
			const source = endpoint(call.callerPaneId);
			const target = endpoint(call.targetPaneId);
			if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
			out.push({
				id: `call:${call.id}`,
				source,
				target,
				type: "stream",
				// Above the petals and the stems.
				zIndex: 1000,
				data: { kind: call.kind, ending } satisfies StreamData,
			});
		}
		return out;
	}, [model, calls, nodeIds, orchestratorPaneId]);

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
 *  resized (the divider, the window), so the flower always fills it. */
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

/** The petals, drawn as one SVG behind everything, with their names. Right
 *  click on a petal opens its Workspace's menu. */
const PetalsNode = memo(function PetalsNode({
	data,
}: NodeProps<Node<PetalsData>>) {
	const { petals, radius } = data;
	const actions = useContext(ActionsContext);
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		id: string;
	} | null>(null);
	return (
		<>
			<svg
				width={radius * 2}
				height={radius * 2}
				viewBox={`${-radius} ${-radius} ${radius * 2} ${radius * 2}`}
				style={{ overflow: "visible", display: "block" }}
			>
				<title>Workspaces</title>
				{petals.map((p, i) => (
					<g key={p.workspaceId}>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: right-click menu of a petal */}
						<path
							d={petalPath(p)}
							className={`orch-petal ${i % 2 ? "orch-petal-odd" : ""}`}
							onContextMenu={(e) => {
								e.preventDefault();
								e.stopPropagation();
								setMenu({ x: e.clientX, y: e.clientY, id: p.workspaceId });
							}}
						/>
						<text
							x={p.label.x}
							y={p.label.y}
							textAnchor={
								Math.abs(p.label.x) < 40
									? "middle"
									: p.label.x > 0
										? "start"
										: "end"
							}
							dominantBaseline="middle"
							style={{
								fill: "var(--fg-secondary)",
								fontSize: 15,
								fontWeight: 600,
								pointerEvents: "none",
							}}
						>
							{p.name}
						</text>
					</g>
				))}
			</svg>
			{menu && actions && (
				<PaneContextMenu
					x={menu.x}
					y={menu.y}
					onClose={() => setMenu(null)}
					items={[
						{
							label: "New agent…",
							onClick: () => actions.newAgentIn(menu.id),
						},
						{
							label: "New task…",
							onClick: () => openNewTask({ workspaceId: menu.id }),
						},
						{ separator: true },
						{
							label: "Close Workspace",
							onClick: () => actions.closeWorkspace(menu.id),
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
			<CentreHandles />
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

/** "Open workspace…": the slot after the last petal. */
const AddNode = memo(function AddNode() {
	return (
		<button
			type="button"
			className="nodrag flex items-center justify-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:border-[var(--accent)] border border-dashed border-[var(--border)]"
			style={{
				width: 150,
				height: 40,
				gap: 6,
				borderRadius: 20,
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
	const { agent, workspaceName, fresh, receiving, small } = data;
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
					gap: small ? 6 : 8,
					padding: small ? "0 8px" : "0 10px",
					borderRadius: 999,
					cursor: "pointer",
					border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
					background: selected
						? "color-mix(in srgb, var(--accent) 14%, var(--bg-primary))"
						: "var(--bg-primary)",
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
					menu.open(e.clientX, e.clientY);
				}}
			>
				<CentreHandles />
				<AgentStatusIcon status={status} size={12} />
				<span style={{ color: "var(--fg-secondary)", display: "flex" }}>
					{Icon ? <Icon size={14} /> : <FallbackAgentIcon size={13} />}
				</span>
				<span className="flex flex-col min-w-0 flex-1">
					<span className="flex items-center min-w-0" style={{ gap: 5 }}>
						<span
							className="truncate"
							style={{
								fontSize: small ? 11.5 : 12.5,
								color: "var(--fg-primary)",
							}}
						>
							{name}
						</span>
						{flag && (
							<span style={{ color: "var(--warning)", display: "flex" }}>
								<BellRing size={11} />
							</span>
						)}
					</span>
					{!small && (
						<span
							className="truncate"
							style={{ fontSize: 11, color: "var(--fg-secondary)" }}
						>
							{progress ?? `${agentName} · ${agent.tabName}`}
						</span>
					)}
				</span>
			</div>
			{menu.element}
		</>
	);
});

const NODE_TYPES = {
	petals: PetalsNode,
	orchestrator: OrchestratorNode,
	add: AddNode,
	agent: AgentNode,
};

// ── Edges ──

/** A faint line from a node's parent: the flower's structure. */
function StemEdge({ sourceX, sourceY, targetX, targetY }: EdgeProps) {
	return (
		<path
			d={`M ${sourceX} ${sourceY} L ${targetX} ${targetY}`}
			style={{
				fill: "none",
				stroke: "color-mix(in srgb, var(--accent) 18%, transparent)",
				strokeWidth: 1,
			}}
		/>
	);
}

/** How many comets flow along a stream at once, and how long one takes. */
const PARTICLES = 6;
const LAP_S = 1.6;
/** A comet's head, then its tail just behind it. */
const TAIL = [0, 0.05, 0.1];

/**
 * A running Agent control call: a stream of comets from caller to target
 * along a curve that bows toward the Orchestrator. Fades out when the call
 * ends; a steady line with reduced motion.
 */
function StreamEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	data,
}: EdgeProps<Edge<StreamData>>) {
	const act = data?.kind !== "read";
	const ending = data?.ending ?? false;
	const color = act ? "var(--accent)" : "var(--fg-secondary)";
	const d = streamPath(sourceX, sourceY, targetX, targetY, 0, 0);
	const still = prefersReducedMotion();
	const comets = still ? [] : Array.from({ length: PARTICLES }, (_, i) => i);
	return (
		<g
			className="orch-stream"
			style={{
				opacity: ending ? 0 : 1,
				transition: `opacity ${FADE_MS}ms ease`,
			}}
		>
			<path
				d={d}
				style={{
					fill: "none",
					stroke: color,
					strokeOpacity: still ? 0.9 : 0.22,
					strokeWidth: act ? 2.4 : 1.6,
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
							dur={`${LAP_S}s`}
							repeatCount="indefinite"
							begin={`${-(i * LAP_S) / PARTICLES - lag}s`}
							path={d}
						/>
					</circle>
				)),
			)}
		</g>
	);
}

const EDGE_TYPES = { stem: StemEdge, stream: StreamEdge };
