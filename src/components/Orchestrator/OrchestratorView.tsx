import {
	ChevronDown,
	ChevronUp,
	Eye,
	FileText,
	Network,
	RefreshCw,
	X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgentHandle } from "../../hooks/useAgentHandle";
import { useAgentPanes } from "../../hooks/useAgentPanes";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import type { OrchestratorFileTab } from "../../lib/ipc";
import { orchestratorPane, pickerAgents } from "../../lib/orchestrator";
import { closePeek } from "../../lib/orchestratorActions";
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
import {
	closeOrchestratorTab,
	openOrchestratorFile,
	requestCloseOrchestratorTab,
	selectOrchestratorTab,
	tabLabel,
	tabPaneId,
} from "../../lib/orchestratorTabs";
import { useExplorerStore } from "../../stores/explorerStore";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FileSearchPalette } from "../FileSearchPalette";
import { WorkspacePicker } from "../FleetConsole/WorkspacePicker";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { SaveConfirmDialog } from "../SaveConfirmDialog";
import { OrchestratorFileTabs } from "./OrchestratorFileTabs";
import { OrchestratorGraph } from "./OrchestratorGraph";
import { PeekPane } from "./PeekPane";

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
	return (
		<>
			{open && <OrchestratorViewBody topOffset={topOffset} />}
			{/* Mounted even while the view is closed: see the component. */}
			<OrchestratorFileTabs topOffset={topOffset} />
			<OrchestratorFileSearch />
		</>
	);
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
	const peekPaneId = useOrchestratorStore((s) => s.peekPaneId);
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
					{phase !== "ready" ? (
						<WelcomeCard />
					) : (
						// The graph, and the **Peek** to its right while there is one.
						<div className="absolute inset-0 flex">
							<div className="relative flex-1 min-w-0">
								<OrchestratorGraph />
							</div>
							{peekPaneId && (
								<div
									className="relative flex flex-col min-w-0"
									style={{
										flex: "1 1 0",
										borderLeft:
											"1px solid color-mix(in srgb, var(--border) 60%, transparent)",
									}}
								>
									<PeekHeader paneId={peekPaneId} />
									<div className="relative flex-1 min-h-0">
										<PeekPane paneId={peekPaneId} />
									</div>
								</div>
							)}
						</div>
					)}
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

/** The file search for an Orchestrator tab (Cmd+P in the view, or a
 *  Workspace's "Open file…"): the pick opens in a tab and takes focus. */
function OrchestratorFileSearch() {
	const search = useOrchestratorStore((s) => s.fileSearch);
	const close = () => useOrchestratorStore.getState().set({ fileSearch: null });
	return (
		<FileSearchPalette
			open={search !== null}
			onClose={close}
			scope={
				search
					? {
							workspaceIds: search.workspaceIds,
							onPick: (workspaceId, entry) => {
								void openOrchestratorFile(
									{ workspaceId, kind: "file", path: entry.path },
									{ focus: true },
								).then(() =>
									useOrchestratorStore.getState().set({ fileTabFocused: true }),
								);
							},
						}
					: undefined
			}
		/>
	);
}

/** A file's **Orchestrator tab**: its name, a dot while it has unsaved
 *  edits, its Workspace in the tooltip. */
function FileTopTab({
	tab,
	active,
	onClose,
}: {
	tab: OrchestratorFileTab;
	active: boolean;
	onClose: () => void;
}) {
	const dirty = useExplorerStore(
		(s) => !!s.filePanes[tabPaneId(tab.id)]?.isDirty,
	);
	const workspaceName = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === tab.workspaceId)?.name ?? "",
	);
	return (
		<TopTab
			active={active}
			onSelect={() => selectOrchestratorTab(tab.id)}
			onClose={onClose}
			title={`${workspaceName} · ${tab.path}`}
		>
			<FileText size={13} />
			<span className="truncate">{tabLabel(tab)}</span>
			{dirty && (
				<span
					title="Unsaved changes"
					style={{
						width: 6,
						height: 6,
						borderRadius: 3,
						background: "var(--accent)",
						flexShrink: 0,
					}}
				/>
			)}
		</TopTab>
	);
}

/** One **Orchestrator tab** in the strip. */
function TopTab({
	active,
	onSelect,
	onClose,
	title,
	children,
}: {
	active: boolean;
	onSelect: () => void;
	onClose?: () => void;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={`flex items-center ${
				active
					? "text-[var(--fg-primary)]"
					: "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
			}`}
			style={{
				height: 24,
				borderRadius: 6,
				background: active
					? "color-mix(in srgb, var(--accent) 14%, transparent)"
					: undefined,
			}}
		>
			<button
				type="button"
				className="flex items-center"
				style={{
					height: 24,
					padding: onClose ? "0 4px 0 10px" : "0 10px",
					gap: 6,
					fontSize: 12,
					cursor: "pointer",
					maxWidth: 220,
				}}
				aria-pressed={active}
				title={title}
				onClick={onSelect}
			>
				{children}
			</button>
			{onClose && (
				<button
					type="button"
					className="flex items-center justify-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
					style={{ width: 20, height: 20, marginRight: 2, borderRadius: 4 }}
					title="Close"
					aria-label="Close"
					onClick={onClose}
				>
					<X size={12} />
				</button>
			)}
		</div>
	);
}

/** The Peek's header: who is peeked at, and the button that ends it (the
 *  terminal's own bar has Close Pane, which closes the real pane). */
function PeekHeader({ paneId }: { paneId: string }) {
	const handle = useAgentHandle(paneId);
	const agentId = usePtyActivityStore((s) => {
		const ptyId = s.panePtyMap[paneId];
		return ptyId ? s.detectedAgentIds[ptyId] : undefined;
	});
	const name = useSettingsStore(
		(s) => s.agents.find((a) => a.id === agentId)?.name,
	);
	return (
		<div
			className="flex items-center shrink-0 select-none text-[var(--fg-secondary)]"
			style={{ height: 26, padding: "0 6px 0 12px", gap: 6, fontSize: 12 }}
		>
			<Eye size={13} />
			<span className="truncate flex-1 text-[var(--fg-primary)]">
				Peek: {handle ?? name ?? "Agent"}
			</span>
			<button
				type="button"
				className="flex items-center justify-center hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
				style={{ width: 22, height: 22, borderRadius: 4 }}
				title="Close the Peek"
				aria-label="Close the Peek"
				onClick={closePeek}
			>
				<X size={13} />
			</button>
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
	const fileTabs = useOrchestratorStore((s) => s.fileTabs);
	const selectedTabId = useOrchestratorStore((s) => s.selectedTabId);
	const closingTabId = useOrchestratorStore((s) => s.closingTabId);
	const closing = fileTabs.find((t) => t.id === closingTabId) ?? null;
	const clearClosing = () =>
		useOrchestratorStore.getState().set({ closingTabId: null });
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
			<TopTab
				active={selectedTabId === null}
				onSelect={() => selectOrchestratorTab(null)}
				title="All agents of this profile"
			>
				<Network size={13} />
				Agents
			</TopTab>
			{fileTabs.map((tab) => (
				<FileTopTab
					key={tab.id}
					tab={tab}
					active={selectedTabId === tab.id}
					onClose={() => requestCloseOrchestratorTab(tab.id)}
				/>
			))}
			{phase === "ready" && <OpenWorkspaceButton />}
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
			{closing && (
				<SaveConfirmDialog
					fileName={tabLabel(closing)}
					onSave={() => {
						const tab = closing;
						clearClosing();
						void useExplorerStore
							.getState()
							.saveFile(tabPaneId(tab.id))
							.then(() => closeOrchestratorTab(tab.id));
					}}
					onDontSave={() => {
						closeOrchestratorTab(closing.id);
						clearClosing();
					}}
					onCancel={() => clearClosing()}
				/>
			)}
		</div>
	);
}

/** "Open workspace…": the Fleet Console's workspace picker, shared with the
 *  graph's '+' node (both open the same list). */
function OpenWorkspaceButton() {
	const open = useOrchestratorStore((s) => s.workspacePickerOpen);
	const tiles = useAgentPanes({ includePending: false });
	const counts = useMemo(() => {
		const m = new Map<string, number>();
		for (const t of tiles)
			m.set(t.workspaceId, (m.get(t.workspaceId) ?? 0) + 1);
		return m;
	}, [tiles]);
	return (
		<WorkspacePicker
			agentCountByWorkspace={counts}
			open={open}
			onOpenChange={(o) =>
				useOrchestratorStore.getState().set({ workspacePickerOpen: o })
			}
			title="Open a workspace — its agents join the graph"
			align="left"
		/>
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
	const exited = useOrchestratorStore((s) => s.exited);
	if (phase === "pick" || changingAgent || exited) return <AgentPicker />;
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
