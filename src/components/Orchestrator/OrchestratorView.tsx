import { ChevronDown, ChevronUp, Network, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { orchestratorPane, pickerAgents } from "../../lib/orchestrator";
import {
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_TAB_STRIP,
	panesTop,
	ratioFor,
	topContentHeight,
} from "../../lib/orchestratorLayout";
import {
	enterOrchestratorView,
	pickOrchestratorAgent,
	restartOrchestrator,
} from "../../lib/orchestratorSession";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { OrchestratorGraph } from "./OrchestratorGraph";

/**
 * The **Orchestrator view** (ADR-0057): the Window's third view, beside the
 * Workspace view and the Fleet Console. Orchestrator tabs across the top (the
 * graph first), the Orchestrator workspace's panes below, always visible.
 *
 * The panes are not drawn here: while the view is on screen the Orchestrator
 * workspace is the Active workspace, and `App.tsx` draws it in the ordinary
 * Workspace stack, placed under this view's top area (`panesTop`). This view
 * draws the top area, and the bottom area only while there are no panes to
 * show yet (loading, the Agent picker, an error).
 */
export function OrchestratorView({ topOffset }: { topOffset: number }) {
	const open = useWindowUiStore((s) => s.orchestratorViewOpen);
	if (!open) return null;
	return <OrchestratorViewBody topOffset={topOffset} />;
}

function OrchestratorViewBody({ topOffset }: { topOffset: number }) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [viewHeight, setViewHeight] = useState(0);
	const ratio = useWindowUiStore((s) => s.orchestratorTopRatio);
	const collapsed = useWindowUiStore((s) => s.orchestratorTopCollapsed);
	const setTopRatio = useWindowUiStore((s) => s.setOrchestratorTopRatio);
	const toggleCollapsed = useWindowUiStore(
		(s) => s.toggleOrchestratorTopCollapsed,
	);
	const phase = useOrchestratorStore((s) => s.phase);
	const changingAgent = useOrchestratorStore((s) => s.changingAgent);

	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const measure = () => setViewHeight(el.clientHeight);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const content = topContentHeight(ratio, collapsed, viewHeight);
	const top = panesTop(content);
	useEffect(() => {
		useOrchestratorStore.getState().set({ panesTop: top });
	}, [top]);

	const exited = useOrchestratorStore((s) => s.exited);
	const showCard = phase !== "ready" || changingAgent || exited;

	return (
		<div
			ref={rootRef}
			data-orchestrator-view
			className="absolute flex flex-col"
			style={{
				top: topOffset,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 25,
				background: "var(--ambient-glow-top), var(--bg-primary)",
			}}
		>
			<TabStrip collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
			{content > 0 && (
				<div className="relative shrink-0" style={{ height: content }}>
					{phase === "ready" ? <OrchestratorGraph /> : <WelcomeCard />}
				</div>
			)}
			<Divider
				onDrag={(dy) => setTopRatio(ratioFor(content + dy, viewHeight))}
				disabled={collapsed}
			/>
			{showCard && (
				<div className="flex-1 min-h-0 flex items-center justify-center">
					<BottomCard />
				</div>
			)}
		</div>
	);
}

function TabStrip({
	collapsed,
	onToggleCollapsed,
}: {
	collapsed: boolean;
	onToggleCollapsed: () => void;
}) {
	const phase = useOrchestratorStore((s) => s.phase);
	const agentId = useOrchestratorStore((s) => s.agentId);
	const agents = useSettingsStore((s) => s.agents);
	const agent = agents.find((a) => a.id === agentId);
	return (
		<div
			className="flex items-center shrink-0 select-none"
			style={{
				height: ORCHESTRATOR_TAB_STRIP,
				padding: "0 10px 0 12px",
				gap: 8,
				borderBottom:
					"1px solid color-mix(in srgb, var(--border) 60%, transparent)",
			}}
		>
			<div
				className="flex items-center text-[var(--fg-primary)]"
				style={{
					height: 24,
					padding: "0 10px",
					gap: 6,
					fontSize: 12,
					borderRadius: 6,
					background: "color-mix(in srgb, var(--accent) 14%, transparent)",
				}}
			>
				<Network size={13} />
				Agents
			</div>
			<div className="flex-1" />
			{phase === "ready" && agent && (
				<button
					type="button"
					className={secondaryButtonClass}
					style={{ height: 24, padding: "0 10px", fontSize: 12 }}
					title="Choose another agent to be the Orchestrator"
					onClick={() =>
						useOrchestratorStore.getState().set({ changingAgent: true })
					}
				>
					{agent.name} · Change…
				</button>
			)}
			<button
				type="button"
				className="flex items-center justify-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
				style={{ width: 24, height: 24, borderRadius: 6 }}
				title={collapsed ? "Show the agents panel" : "Hide the agents panel"}
				aria-label={
					collapsed ? "Show the agents panel" : "Hide the agents panel"
				}
				onClick={onToggleCollapsed}
			>
				{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
			</button>
		</div>
	);
}

/** Stand-in for the graph (step 6 of docs/plans/orchestrator.md). */
function WelcomeCard() {
	const running = useOrchestratorRunning();
	const phase = useOrchestratorStore((s) => s.phase);
	return (
		<div
			className="absolute inset-0 flex flex-col items-center justify-center text-center"
			style={{ gap: 10, padding: "0 24px", color: "var(--fg-secondary)" }}
		>
			<div
				style={{ fontSize: 15, color: "var(--fg-primary)", fontWeight: 600 }}
			>
				Ask about your agents
			</div>
			<div style={{ fontSize: 13, maxWidth: 520, lineHeight: 1.5 }}>
				The Orchestrator can see every agent in this profile. Ask it what they
				are working on, who needs you, or to pass a message along. It asks you
				before it changes anything.
			</div>
			{phase === "ready" && !running && (
				<div className="flex items-center" style={{ gap: 10, marginTop: 6 }}>
					<span style={{ fontSize: 12 }}>The Orchestrator is not running.</span>
					<button
						type="button"
						className={primaryButtonClass}
						style={{ height: 26, padding: "0 12px", fontSize: 12, gap: 6 }}
						onClick={() => void restartOrchestrator()}
					>
						<RefreshCw size={12} />
						Start the Orchestrator
					</button>
				</div>
			)}
		</div>
	);
}

/** Whether a pane of the Orchestrator workspace carries the Orchestrator
 *  handle, i.e. its Agent has not left (the handle goes with the Agent). */
function useOrchestratorRunning(): boolean {
	const workspaceId = useOrchestratorStore((s) => s.workspaceId);
	const tabs = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === workspaceId)?.tabs,
	);
	return useMemo(() => !!tabs && orchestratorPane(tabs) !== null, [tabs]);
}

function Divider({
	onDrag,
	disabled,
}: {
	onDrag: (dy: number) => void;
	disabled: boolean;
}) {
	const start = useRef<number | null>(null);
	return (
		<div
			className={disabled ? "shrink-0" : "shrink-0 hover:bg-[var(--accent)]"}
			style={{
				height: ORCHESTRATOR_DIVIDER,
				cursor: disabled ? "default" : "row-resize",
				background: "color-mix(in srgb, var(--border) 40%, transparent)",
			}}
			onPointerDown={(e) => {
				if (disabled) return;
				// No text selection while dragging, in the graph or the panes:
				// the same body class the pane resizers use.
				e.preventDefault();
				document.body.classList.add("dragging");
				start.current = e.clientY;
				e.currentTarget.setPointerCapture(e.pointerId);
			}}
			onPointerMove={(e) => {
				if (start.current === null) return;
				const dy = e.clientY - start.current;
				if (dy === 0) return;
				start.current = e.clientY;
				onDrag(dy);
			}}
			onPointerUp={(e) => {
				start.current = null;
				document.body.classList.remove("dragging");
				e.currentTarget.releasePointerCapture(e.pointerId);
			}}
			onLostPointerCapture={() => {
				start.current = null;
				document.body.classList.remove("dragging");
			}}
		/>
	);
}

function BottomCard() {
	const phase = useOrchestratorStore((s) => s.phase);
	const error = useOrchestratorStore((s) => s.error);
	const changingAgent = useOrchestratorStore((s) => s.changingAgent);
	if (phase === "pick" || changingAgent) return <AgentPicker />;
	if (phase === "error") {
		return (
			<div
				className="flex flex-col items-center text-center"
				style={{ gap: 10, fontSize: 13, color: "var(--fg-secondary)" }}
			>
				<span style={{ color: "var(--error)" }}>
					The Orchestrator could not start.
				</span>
				{error && <span style={{ fontSize: 12 }}>{error}</span>}
				<button
					type="button"
					className={secondaryButtonClass}
					style={{ height: 26, padding: "0 12px", fontSize: 12 }}
					onClick={() => void enterOrchestratorView()}
				>
					Try again
				</button>
			</div>
		);
	}
	return (
		<span style={{ fontSize: 13, color: "var(--fg-secondary)" }}>
			Starting the Orchestrator…
		</span>
	);
}

function AgentPicker() {
	const agents = useSettingsStore((s) => s.agents);
	const current = useOrchestratorStore((s) => s.agentId);
	const changingAgent = useOrchestratorStore((s) => s.changingAgent);
	const exited = useOrchestratorStore((s) => s.exited);
	const choices = useMemo(() => pickerAgents(agents), [agents]);
	return (
		<div
			className="flex flex-col items-center text-center"
			style={{
				gap: 12,
				maxWidth: 520,
				padding: "20px 24px",
				borderRadius: 10,
				border: "1px solid var(--border)",
				background: "var(--bg-secondary)",
			}}
		>
			<div
				style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-primary)" }}
			>
				{exited
					? "The Orchestrator has stopped"
					: changingAgent
						? "Choose another Orchestrator"
						: "Choose your Orchestrator"}
			</div>
			<div
				style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg-secondary)" }}
			>
				{exited
					? "Choose the agent to start again. The same one picks up where it left off."
					: "Pick the AI agent that answers your questions about the other agents."}
				{changingAgent && !exited && " The current one is stopped."}
			</div>
			{choices.length === 0 ? (
				<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
					No agents are switched on. Turn one on in Settings ▸ Agents.
				</span>
			) : (
				<div className="flex flex-wrap justify-center" style={{ gap: 8 }}>
					{choices.map((a) => {
						const Icon = getAgentIconComponent(a.id);
						const isCurrent = a.id === current;
						return (
							<button
								key={a.id}
								type="button"
								className="flex items-center text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)] hover:border-[var(--accent)] border border-[var(--border)]"
								style={{
									height: 30,
									padding: "0 12px 0 10px",
									gap: 6,
									borderRadius: 999,
									fontSize: 12,
									cursor: "pointer",
								}}
								aria-current={isCurrent || undefined}
								onClick={() => void pickOrchestratorAgent(a.id)}
							>
								{Icon ? <Icon size={14} /> : <FallbackAgentIcon size={13} />}
								{a.name}
								{isCurrent && (exited ? " (last used)" : " (current)")}
							</button>
						);
					})}
				</div>
			)}
			{(changingAgent || exited) && (
				<button
					type="button"
					className={secondaryButtonClass}
					style={{ height: 24, padding: "0 10px", fontSize: 12 }}
					onClick={() =>
						useOrchestratorStore
							.getState()
							.set({ changingAgent: false, exited: false })
					}
				>
					{exited ? "Not now" : "Cancel"}
				</button>
			)}
		</div>
	);
}
