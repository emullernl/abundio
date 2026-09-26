import { AnimatePresence, motion } from "framer-motion";
import {
	ChevronDown,
	ChevronRight,
	CircleDot,
	CornerDownLeft,
	GitBranch,
	Plus,
	RotateCcw,
	Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useWorktreeProgress } from "../../hooks/useWorktreeProgress";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { agentTaskArgvFor } from "../../lib/agents";
import { type GithubIssue, issues as issuesApi, shells } from "../../lib/ipc";
import {
	type AgentPane,
	defaultRestartPane,
	defaultTaskAgentId,
	defaultWorktreeFolder,
	initialDestination,
	shellSupportsTasks,
	stepIssueIndex,
	type TaskDestination,
	taskAgents,
	visibleIssue,
	workspaceAgentPanes,
} from "../../lib/newTask";
import { revealPane } from "../../lib/paneLocation";
import { restartPaneWithTask } from "../../lib/paneRestart";
import { collectTerminalIds, parseTabLayout } from "../../lib/paneTree";
import { isMac } from "../../lib/platform";
import {
	resolveTaskPrompt,
	suggestBranchForIssue,
	type Task,
	taskTabName,
} from "../../lib/taskPrompt";
import {
	addWorktreeTargetId,
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { basename, isValidBranch, resolvePath } from "../../lib/worktreePath";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
	type NewTaskRequest,
	useWindowUiStore,
} from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { BackButton } from "../FleetConsole/NewAgentDialog";
import {
	paramBodyInputStyle,
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";
import { Select } from "../PromptActions/Select";
import { WorktreeProgressDialog } from "../WorktreeProgressDialog";

type Source = "text" | "issue";

type IssueState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; items: GithubIssue[] };

/**
 * **New task**: start a **Task-capable** Agent with a Task as its first
 * prompt, in one of three **Task destinations**. See CONTEXT.md and ADR-0042.
 *
 * Opened from the keyboard, the Command palette, the Tab bar, a sidebar row's
 * menu, or the Fleet Console's Add agent. From the Console (`fromFleet`) the
 * Workspace view is left alone: new Tabs and worktrees open in the background
 * and join the grid, and the target Workspace can be changed in the dialog.
 */
export function NewTaskDialog({ request }: { request: NewTaskRequest }) {
	const { fromFleet, onBack } = request;
	const close = () => useWindowUiStore.getState().closeNewTask();

	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const focusedPaneId = useWorkspaceStore((s) => s.focusedPaneId);
	const focusedTileId = useWindowUiStore((s) => s.focusedTileId);
	const facts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const repoSlugsById = useWorkspaceGitStore((s) => s.repoSlugsById);
	const gitInfo = useWorkspaceGitStore((s) => s.byWorkspaceId);
	const agents = useSettingsStore((s) => s.agents);
	const taskTemplate = useSettingsStore((s) => s.taskTemplate);
	const issueTemplate = useSettingsStore((s) => s.issueTemplate);
	const rememberedDestination = useSettingsStore((s) => s.taskDestination);
	const shellPath = useSettingsStore((s) => s.shellPath);
	const panePtyMap = usePtyActivityStore((s) => s.panePtyMap);
	const agentPtyIds = usePtyActivityStore((s) => s.agentPtyIds);
	const detectedAgentIds = usePtyActivityStore((s) => s.detectedAgentIds);
	const activities = usePtyActivityStore((s) => s.activities);

	const [workspaceId, setWorkspaceId] = useState(
		request.workspaceId ?? activeWorkspaceId ?? workspaces[0]?.id ?? "",
	);
	const ws = workspaces.find((w) => w.id === workspaceId);
	const focused = fromFleet ? focusedTileId : focusedPaneId;

	const agentPanes = useMemo(
		() =>
			ws
				? workspaceAgentPanes(ws, {
						panePtyMap,
						agentPtyIds,
						detectedAgentIds,
						activities,
					})
				: [],
		[ws, panePtyMap, agentPtyIds, detectedAgentIds, activities],
	);
	const canRestart = agentPanes.length > 0;
	const worktreeTargetId = ws
		? addWorktreeTargetId(workspaces, facts, ws.id)
		: null;
	const worktreePrimary = workspaces.find((w) => w.id === worktreeTargetId);
	const canWorktree = !!worktreePrimary;

	const offered = useMemo(() => taskAgents(agents), [agents]);

	// ── Source ──
	const [source, setSource] = useState<Source>("text");
	const [input, setInput] = useState("");
	const [note, setNote] = useState("");
	const [issueQuery, setIssueQuery] = useState("");
	const [issueState, setIssueState] = useState<IssueState>({ status: "idle" });
	const [issue, setIssue] = useState<GithubIssue | null>(null);
	const issueListRef = useRef<HTMLDivElement>(null);
	// A Workspace whose remotes were checked and point at no GitHub repository
	// has no issues to offer. Unknown (not checked yet) still offers them; the
	// fetch then reports whatever is wrong.
	const slugs = ws ? repoSlugsById[ws.id] : undefined;
	const isGitRepo = ws ? gitInfo[ws.id]?.isGitRepo !== false : false;
	const issuesUnavailable = !isGitRepo
		? "This workspace is not a git repository."
		: slugs && slugs.length === 0
			? "This workspace has no GitHub remote."
			: null;

	// ── Destination ──
	const [destination, setDestination] = useState<TaskDestination>(() =>
		initialDestination(rememberedDestination, canRestart),
	);
	const effectiveDestination: TaskDestination =
		destination === "restart" && !canRestart
			? "newTab"
			: destination === "worktree" && !canWorktree
				? "newTab"
				: destination;
	const autoRestart = defaultRestartPane(agentPanes, focused);
	const [restartPaneId, setRestartPaneId] = useState<string | null>(null);
	const restartPane: AgentPane | null =
		agentPanes.find((p) => p.paneId === restartPaneId) ?? autoRestart;
	const [confirmBusy, setConfirmBusy] = useState(false);

	// ── Agent ──
	const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
	const agentId =
		pickedAgentId && offered.some((a) => a.id === pickedAgentId)
			? pickedAgentId
			: defaultTaskAgentId(offered, [
					effectiveDestination === "restart" ? restartPane?.agentId : undefined,
					focused
						? agentPanes.find((p) => p.paneId === focused)?.agentId
						: undefined,
					...agentPanes.map((p) => p.agentId),
				]);
	const agent = offered.find((a) => a.id === agentId);

	// ── Worktree ──
	const repo = worktreePrimary ? basename(worktreePrimary.rootFolder) : "";
	const [branch, setBranch] = useState("");
	const [branchDirty, setBranchDirty] = useState(false);
	const [folder, setFolder] = useState("");
	const [folderDirty, setFolderDirty] = useState(false);
	useEffect(() => {
		if (branchDirty) return;
		setBranch(source === "issue" && issue ? suggestBranchForIssue(issue) : "");
	}, [source, issue, branchDirty]);
	useEffect(() => {
		if (!folderDirty) setFolder(defaultWorktreeFolder(repo, branch));
	}, [repo, branch, folderDirty]);
	const branchValid = isValidBranch(branch);

	// ── Shell support (ADR-0042) ──
	const [shell, setShell] = useState<string | null>(shellPath);
	useEffect(() => {
		if (shellPath) {
			setShell(shellPath);
			return;
		}
		shells
			.default()
			.then(setShell)
			.catch(() => setShell(null));
	}, [shellPath]);
	const shellOk = shell === null || shellSupportsTasks(shell);

	// ── Issues ──
	// Keyed on the folder, not the Workspace object: that is replaced on every
	// layout change, which would refetch and drop the picked issue. Not keyed
	// on the source tab either, for the same reason: `issuesWanted` turns on
	// the first time the Issue tab opens and stays on, so switching to Describe
	// and back keeps the list and the pick without another `gh` round trip.
	// Only a different folder (another Workspace) refetches and clears the pick.
	const wsFolder = ws?.rootFolder;
	const [issuesWanted, setIssuesWanted] = useState(false);
	useEffect(() => {
		if (!issuesWanted || !wsFolder || issuesUnavailable) return;
		let cancelled = false;
		setIssueState({ status: "loading" });
		setIssue(null);
		issuesApi
			.list(wsFolder)
			.then((items) => {
				if (!cancelled) setIssueState({ status: "ready", items });
			})
			.catch((e) => {
				if (!cancelled)
					setIssueState({
						status: "error",
						message: String(e).replace(/^Git error: /, ""),
					});
			});
		return () => {
			cancelled = true;
		};
	}, [issuesWanted, wsFolder, issuesUnavailable]);

	const filteredIssues = useMemo(() => {
		if (issueState.status !== "ready") return [];
		const q = issueQuery.trim().toLowerCase().replace(/^#/, "");
		if (!q) return issueState.items;
		return issueState.items.filter(
			(i) =>
				String(i.number).startsWith(q) || i.title.toLowerCase().includes(q),
		);
	}, [issueState, issueQuery]);

	// ── The Task ──
	// The pick counts only while the search still shows it.
	const shownIssue = visibleIssue(issue, filteredIssues);
	const task: Task | null =
		source === "text"
			? input.trim()
				? { kind: "text", input, note }
				: null
			: shownIssue
				? { kind: "issue", issue: shownIssue, note }
				: null;
	const prompt = task
		? resolveTaskPrompt(task, { taskTemplate, issueTemplate })
		: "";
	const [showPreview, setShowPreview] = useState(false);

	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const progress = useWorktreeProgress();

	const blocker = !shellOk
		? `New task needs zsh or bash as the terminal shell (this one is ${basename(shell ?? "")}). Change it in Settings ▸ Terminal.`
		: offered.length === 0
			? "No task-capable agent is switched on. Turn one on in Settings ▸ Agents."
			: null;
	const canSubmit =
		!!ws &&
		!!task &&
		!!agent &&
		!blocker &&
		!starting &&
		(effectiveDestination !== "restart" || !!restartPane) &&
		(effectiveDestination !== "worktree" || (branchValid && !!folder));

	useEscapeKey(() => {
		if (!progress.display) close();
	});

	const pickDestination = (d: TaskDestination) => {
		setDestination(d);
		setConfirmBusy(false);
		// Remembered only on an explicit pick, and only the two in-Workspace
		// destinations: a worktree is a per-Task decision.
		if (d !== "worktree") useSettingsStore.getState().setTaskDestination(d);
	};

	const submit = async () => {
		if (!canSubmit || !ws || !task || !agent) return;
		const argv = agentTaskArgvFor(agents, agent.id, prompt);
		if (!argv) return;
		const tabName = taskTabName(task);
		setError(null);

		if (effectiveDestination === "restart" && restartPane) {
			if (restartPane.busy && !confirmBusy) {
				setConfirmBusy(true);
				return;
			}
			setStarting(true);
			try {
				await restartPaneWithTask(restartPane.paneId, {
					argv,
					agentId: agent.id,
				});
			} catch (e) {
				setStarting(false);
				setError(`Could not restart the agent: ${String(e)}`);
				return;
			}
			if (fromFleet) {
				useWindowUiStore.getState().setFocusedTile(restartPane.paneId);
			} else {
				revealPane(restartPane.paneId, ws.id, restartPane.tabId);
			}
			close();
			return;
		}

		if (effectiveDestination === "newTab") {
			setStarting(true);
			try {
				const tab = await useWorkspaceStore
					.getState()
					.createTab(ws.id, agent, undefined, {
						// The Console never rearranges the Workspace view (ADR-0040).
						activate: !fromFleet,
						task: { argv, agentId: agent.id, tabName },
					});
				const activity = usePtyActivityStore.getState();
				if (!activity.openedWorkspaceIds.has(ws.id)) {
					activity.markWorkspaceOpened(ws.id);
				}
				const layout = parseTabLayout(tab.layoutJson);
				const paneId = layout ? collectTerminalIds(layout)[0] : undefined;
				if (fromFleet) {
					if (paneId) useWindowUiStore.getState().expectFleetTile(paneId);
				} else if (ws.id !== activeWorkspaceId) {
					useWorkspaceStore.getState().beginWorkspaceSwitch(ws.id);
				}
			} catch (e) {
				setStarting(false);
				setError(`Could not start ${agent.name}: ${String(e)}`);
				return;
			}
			close();
			return;
		}

		if (effectiveDestination === "worktree" && worktreePrimary) {
			const primaryCwd = worktreePrimary.rootFolder;
			setStarting(true);
			const result = await progress.run(
				{ verb: "Creating", target: branch },
				async () => {
					await useWorkspaceStore
						.getState()
						.createWorktreeWorkspace(
							primaryCwd,
							branch,
							resolvePath(primaryCwd, folder),
							worktreePrimary.worktreeSetupCommands ?? "",
							agent,
							{
								background: fromFleet,
								task: {
									argv,
									agentId: agent.id,
									tabName,
									// Wherever the store seeds it — the new Workspace's
									// focal pane, or a new Tab if it was already open.
									onSeeded: fromFleet
										? (paneId) =>
												useWindowUiStore.getState().expectFleetTile(paneId)
										: undefined,
								},
							},
						);
				},
			);
			setStarting(false);
			if (result.ok) close();
		}
	};

	// While the worktree is being created, the form steps aside for the
	// waiting modal; its error state's Edit brings the form back as it was.
	if (progress.display) {
		return (
			<WorktreeProgressDialog
				verb={progress.display.verb}
				target={progress.display.target}
				status={progress.display.status}
				error={progress.display.error}
				onClose={() => {
					progress.dismiss();
					close();
				}}
				onEdit={progress.dismiss}
			/>
		);
	}

	const orderedWorkspaces = flattenRowsToIds(
		buildWorkspaceRows(workspaces, facts),
	)
		.map((id) => workspaces.find((w) => w.id === id))
		.filter((w) => !!w);

	const moveIssue = (step: 1 | -1) => {
		const current = shownIssue
			? filteredIssues.findIndex((i) => i.number === shownIssue.number)
			: -1;
		const next = stepIssueIndex(current, step, filteredIssues.length);
		if (next === null) return;
		setIssue(filteredIssues[next]);
		issueListRef.current
			?.querySelector(`[data-index="${next}"]`)
			?.scrollIntoView({ block: "nearest" });
	};

	const submitLabel =
		effectiveDestination === "restart"
			? confirmBusy
				? "Interrupt and restart"
				: "Restart with task"
			: effectiveDestination === "worktree"
				? "Create worktree & start"
				: "Start task";

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[200] flex items-center justify-center"
				initial={onBack ? false : { opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				style={{
					backgroundColor: "rgba(0,0,0,0.55)",
					backdropFilter: "blur(6px)",
					WebkitBackdropFilter: "blur(6px)",
				}}
				onClick={close}
			>
				<motion.div
					role="dialog"
					aria-label="New task"
					className="rounded-2xl overflow-hidden flex flex-col outline-none"
					initial={onBack ? false : { opacity: 0, scale: 0.96, y: 12 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.96, y: 12 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 600,
						maxHeight: "min(760px, 90vh)",
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 40px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						// Keep keystrokes away from the terminal underneath.
						e.stopPropagation();
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							void submit();
						}
					}}
				>
					{/* ── Header ── */}
					<div
						className="flex items-center justify-between"
						style={{ padding: "22px 28px 0", gap: 12 }}
					>
						<div className="flex items-center" style={{ gap: 8 }}>
							{onBack && <BackButton onClick={onBack} />}
							<span
								style={{
									color: "var(--accent)",
									fontSize: 10,
									fontWeight: 600,
									letterSpacing: "0.14em",
									textTransform: "uppercase",
								}}
							>
								New task
							</span>
						</div>
						{fromFleet ? (
							<Select
								aria-label="Workspace"
								value={workspaceId}
								options={orderedWorkspaces.map((w) => ({
									value: w.id,
									label: w.name,
								}))}
								onChange={(id) => {
									setWorkspaceId(id);
									setRestartPaneId(null);
									setConfirmBusy(false);
									setIssue(null);
								}}
								width={220}
								style={{
									height: 28,
									fontSize: 12,
									padding: "0 8px",
									borderRadius: 6,
									color: "var(--fg-primary)",
									backgroundColor: "var(--bg-primary)",
									border: "1px solid var(--border)",
								}}
							/>
						) : (
							<span
								className="truncate"
								style={{
									fontSize: 12,
									color: "var(--fg-secondary)",
									maxWidth: 300,
								}}
								title={ws?.rootFolder}
							>
								in{" "}
								<strong style={{ color: "var(--fg-primary)" }}>
									{ws?.name}
								</strong>
							</span>
						)}
					</div>

					<div
						className="flex-1 min-h-0 overflow-y-auto flex flex-col"
						style={{ padding: "14px 28px 4px", gap: 18 }}
					>
						{/* ── Source ── */}
						<div className="flex flex-col" style={{ gap: 10 }}>
							<div className="flex" role="tablist" style={{ gap: 18 }}>
								<SourceTab
									selected={source === "text"}
									onClick={() => setSource("text")}
								>
									Describe
								</SourceTab>
								<SourceTab
									selected={source === "issue"}
									disabled={!!issuesUnavailable}
									title={issuesUnavailable ?? undefined}
									onClick={() => {
										setSource("issue");
										setIssuesWanted(true);
									}}
								>
									<CircleDot size={12} />
									GitHub issue
								</SourceTab>
							</div>

							{source === "text" ? (
								<textarea
									// biome-ignore lint/a11y/noAutofocus: the dialog's first job is the task
									autoFocus
									value={input}
									onChange={(e) => setInput(e.target.value)}
									placeholder="What needs doing? Describe the problem or the feature…"
									rows={6}
									spellCheck
									className="rounded-lg"
									style={{
										...paramBodyInputStyle,
										fontFamily: "inherit",
										fontSize: 14,
										lineHeight: 1.55,
										padding: "12px 14px",
										resize: "vertical",
										minHeight: 120,
									}}
								/>
							) : (
								<div className="flex flex-col" style={{ gap: 8 }}>
									<div
										className="flex items-center rounded-lg"
										style={{
											gap: 8,
											height: 36,
											padding: "0 12px",
											backgroundColor: "var(--bg-primary)",
											border: "1px solid var(--border)",
										}}
									>
										<Search size={13} color="var(--fg-secondary)" />
										<input
											// biome-ignore lint/a11y/noAutofocus: picking an issue is the next step
											autoFocus
											value={issueQuery}
											onChange={(e) => setIssueQuery(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "ArrowDown") {
													e.preventDefault();
													moveIssue(1);
												} else if (e.key === "ArrowUp") {
													e.preventDefault();
													moveIssue(-1);
												}
											}}
											placeholder="Search open issues by number or title"
											spellCheck={false}
											className="flex-1 bg-transparent outline-none"
											style={{ fontSize: 13, color: "var(--fg-primary)" }}
										/>
									</div>
									<div
										ref={issueListRef}
										className="overflow-y-auto rounded-lg"
										style={{
											maxHeight: 220,
											minHeight: 96,
											border: "1px solid var(--border)",
											backgroundColor:
												"color-mix(in srgb, var(--bg-primary) 60%, transparent)",
										}}
									>
										<IssueList
											state={issueState}
											items={filteredIssues}
											selected={shownIssue}
											onSelect={(i) => setIssue(i)}
										/>
									</div>
								</div>
							)}

							<textarea
								value={note}
								onChange={(e) => setNote(e.target.value)}
								placeholder={
									source === "issue"
										? "Add a note for the agent (optional)"
										: "Anything else? (optional, added after the task)"
								}
								rows={source === "issue" ? 2 : 1}
								className="rounded-lg"
								style={{
									...paramBodyInputStyle,
									fontFamily: "inherit",
									fontSize: 12.5,
									padding: "8px 12px",
									resize: "vertical",
								}}
							/>
						</div>

						{/* ── Destination ── */}
						<Section label="Where">
							<div
								className="grid rounded-lg"
								style={{
									gridTemplateColumns: "repeat(3, 1fr)",
									gap: 4,
									padding: 4,
									backgroundColor: "var(--bg-primary)",
									border: "1px solid var(--border)",
								}}
							>
								<DestinationButton
									icon={<RotateCcw size={14} />}
									label="Restart agent"
									hint={
										canRestart
											? "Replace a running agent"
											: "No agent runs here"
									}
									selected={effectiveDestination === "restart"}
									disabled={!canRestart}
									onClick={() => pickDestination("restart")}
								/>
								<DestinationButton
									icon={<Plus size={14} />}
									label="New tab"
									hint="Alongside what's open"
									selected={effectiveDestination === "newTab"}
									onClick={() => pickDestination("newTab")}
								/>
								<DestinationButton
									icon={<GitBranch size={14} />}
									label="New worktree"
									hint={
										canWorktree ? "On a fresh branch" : "Not a git workspace"
									}
									selected={effectiveDestination === "worktree"}
									disabled={!canWorktree}
									onClick={() => pickDestination("worktree")}
								/>
							</div>

							{effectiveDestination === "restart" && (
								<RestartDetail
									panes={agentPanes}
									selected={restartPane}
									onSelect={(id) => {
										setRestartPaneId(id);
										setConfirmBusy(false);
									}}
									agentName={(id) =>
										agents.find((a) => a.id === id)?.name ?? "Agent"
									}
									confirmBusy={confirmBusy}
								/>
							)}

							{effectiveDestination === "worktree" && worktreePrimary && (
								<div
									className="grid"
									style={{
										gridTemplateColumns: "1fr 1fr",
										gap: 8,
										marginTop: 10,
									}}
								>
									<LabeledInput
										label={`Branch${
											worktreePrimary.id !== ws?.id
												? ` (from ${worktreePrimary.name})`
												: ""
										}`}
										value={branch}
										invalid={!!branch && !branchValid}
										placeholder="feature/my-task"
										onChange={(v) => {
											setBranch(v);
											setBranchDirty(true);
										}}
									/>
									<LabeledInput
										label="Folder"
										value={folder}
										placeholder={`../${repo}.worktrees/…`}
										onChange={(v) => {
											setFolder(v);
											setFolderDirty(true);
										}}
									/>
								</div>
							)}
						</Section>

						{/* ── Agent ── */}
						<Section label="Agent">
							<div className="flex flex-wrap" style={{ gap: 6 }}>
								{offered.map((a) => {
									const Icon = getAgentIconComponent(a.id);
									const selected = a.id === agentId;
									return (
										<button
											key={a.id}
											type="button"
											onClick={() => setPickedAgentId(a.id)}
											aria-pressed={selected}
											className={`flex items-center ${
												selected
													? "text-[var(--fg-primary)]"
													: "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
											}`}
											style={{
												height: 28,
												padding: "0 10px 0 8px",
												gap: 6,
												borderRadius: 999,
												fontSize: 12,
												cursor: "pointer",
												border: `1px solid ${
													selected ? "var(--accent)" : "var(--border)"
												}`,
												background: selected
													? "color-mix(in srgb, var(--accent) 14%, transparent)"
													: undefined,
											}}
										>
											{Icon ? (
												<Icon size={14} />
											) : (
												<FallbackAgentIcon size={13} />
											)}
											{a.name}
										</button>
									);
								})}
							</div>
						</Section>

						{/* ── Preview ── */}
						<div>
							<button
								type="button"
								onClick={() => setShowPreview((v) => !v)}
								aria-expanded={showPreview}
								className="flex items-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
								style={{ gap: 4, fontSize: 11.5, cursor: "pointer" }}
							>
								{showPreview ? (
									<ChevronDown size={12} />
								) : (
									<ChevronRight size={12} />
								)}
								Show prompt
							</button>
							{showPreview && (
								<pre
									className="rounded-md"
									style={{
										marginTop: 6,
										fontFamily: "var(--font-mono)",
										fontSize: 11.5,
										lineHeight: 1.5,
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										color: prompt ? "var(--fg-primary)" : "var(--fg-secondary)",
										backgroundColor: "var(--bg-tertiary)",
										padding: "10px 12px",
										maxHeight: 160,
										overflowY: "auto",
									}}
								>
									{prompt ||
										(source === "issue"
											? "Pick an issue to see the prompt."
											: "Describe the task to see the prompt.")}
								</pre>
							)}
						</div>
					</div>

					{/* ── Footer ── */}
					<div
						className="flex items-center justify-between"
						style={{
							padding: "14px 28px 20px",
							gap: 12,
							borderTop: "1px solid var(--border)",
							marginTop: 10,
						}}
					>
						{error || blocker ? (
							<span
								role="alert"
								style={{
									fontSize: 11.5,
									color: error ? "var(--error)" : "var(--warning, #d99a2b)",
									lineHeight: 1.4,
								}}
							>
								{error ?? blocker}
							</span>
						) : (
							<span
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									opacity: 0.7,
								}}
							>
								{isMac ? "⌘" : "Ctrl+"}↵ to start
							</span>
						)}
						<div className="flex flex-shrink-0" style={{ gap: 8 }}>
							<button
								type="button"
								onClick={close}
								className={secondaryButtonClass}
								style={{ height: 32, padding: "0 14px", borderRadius: 6 }}
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								onClick={() => void submit()}
								className={`flex items-center ${primaryButtonClass}`}
								style={{
									height: 32,
									padding: "0 14px",
									gap: 6,
									borderRadius: 6,
									color: "var(--bg-primary)",
									backgroundColor: confirmBusy
										? "var(--warning, #d99a2b)"
										: "var(--accent)",
									opacity: canSubmit ? 1 : 0.5,
								}}
							>
								{submitLabel}
								<CornerDownLeft size={12} />
							</button>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}

function Section({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div
				style={{
					fontSize: 10,
					fontWeight: 600,
					letterSpacing: "0.1em",
					textTransform: "uppercase",
					color: "var(--fg-secondary)",
					opacity: 0.8,
					marginBottom: 8,
				}}
			>
				{label}
			</div>
			{children}
		</div>
	);
}

function SourceTab({
	selected,
	disabled,
	title,
	onClick,
	children,
}: {
	selected: boolean;
	disabled?: boolean;
	title?: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={selected}
			disabled={disabled}
			title={title}
			onClick={onClick}
			className={`flex items-center ${
				selected
					? "text-[var(--fg-primary)]"
					: "text-[var(--fg-secondary)] enabled:hover:text-[var(--fg-primary)]"
			} disabled:opacity-40 disabled:cursor-default`}
			style={{
				gap: 6,
				height: 26,
				fontSize: 13,
				fontWeight: selected ? 600 : 400,
				cursor: "pointer",
				boxShadow: selected ? "inset 0 -2px 0 var(--accent)" : undefined,
			}}
		>
			{children}
		</button>
	);
}

function DestinationButton({
	icon,
	label,
	hint,
	selected,
	disabled,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	hint: string;
	selected: boolean;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			disabled={disabled}
			onClick={onClick}
			className={`flex flex-col items-start text-left rounded-md transition-colors ${
				selected
					? ""
					: "enabled:hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-default"
			}`}
			style={{
				padding: "8px 10px",
				gap: 2,
				cursor: "pointer",
				background: selected
					? "color-mix(in srgb, var(--accent) 16%, transparent)"
					: undefined,
				boxShadow: selected ? "inset 0 0 0 1px var(--accent)" : undefined,
			}}
		>
			<span
				className="flex items-center"
				style={{
					gap: 6,
					fontSize: 12.5,
					fontWeight: 600,
					color: selected ? "var(--fg-primary)" : "var(--fg-secondary)",
				}}
			>
				<span style={{ color: selected ? "var(--accent)" : undefined }}>
					{icon}
				</span>
				{label}
			</span>
			<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>{hint}</span>
		</button>
	);
}

function RestartDetail({
	panes,
	selected,
	onSelect,
	agentName,
	confirmBusy,
}: {
	panes: AgentPane[];
	selected: AgentPane | null;
	onSelect: (paneId: string) => void;
	agentName: (id: string | undefined) => string;
	confirmBusy: boolean;
}) {
	return (
		<div className="flex flex-col" style={{ gap: 6, marginTop: 10 }}>
			{panes.length > 1 && (
				<div className="flex flex-wrap" style={{ gap: 6 }}>
					{panes.map((p) => {
						const isSel = p.paneId === selected?.paneId;
						return (
							<button
								key={p.paneId}
								type="button"
								onClick={() => onSelect(p.paneId)}
								aria-pressed={isSel}
								className={
									isSel
										? "text-[var(--fg-primary)]"
										: "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
								}
								style={{
									height: 26,
									padding: "0 10px",
									borderRadius: 6,
									fontSize: 12,
									cursor: "pointer",
									border: `1px solid ${isSel ? "var(--accent)" : "var(--border)"}`,
									background: isSel
										? "color-mix(in srgb, var(--accent) 12%, transparent)"
										: undefined,
								}}
							>
								{p.tabName} · {agentName(p.agentId)}
								{p.busy ? ` · ${p.busy}` : ""}
							</button>
						);
					})}
				</div>
			)}
			<div
				style={{
					fontSize: 11.5,
					lineHeight: 1.45,
					color: confirmBusy
						? "var(--warning, #d99a2b)"
						: "var(--fg-secondary)",
				}}
			>
				{!selected
					? "Several agents run here — pick the one to restart."
					: confirmBusy
						? `${agentName(selected.agentId)} in “${selected.tabName}” is ${selected.busy}. Restarting ends that session. Press again to go ahead.`
						: `Ends the ${agentName(selected.agentId)} session in “${selected.tabName}” and starts a fresh one with this task.`}
			</div>
		</div>
	);
}

function LabeledInput({
	label,
	value,
	placeholder,
	invalid,
	onChange,
}: {
	label: string;
	value: string;
	placeholder: string;
	invalid?: boolean;
	onChange: (v: string) => void;
}) {
	return (
		<label className="flex flex-col" style={{ gap: 4, minWidth: 0 }}>
			<span
				className="truncate"
				style={{ fontSize: 11, color: "var(--fg-secondary)" }}
			>
				{label}
			</span>
			<input
				value={value}
				placeholder={placeholder}
				spellCheck={false}
				onChange={(e) => onChange(e.target.value)}
				className="rounded-md"
				style={{
					height: 32,
					padding: "0 10px",
					fontSize: 12,
					fontFamily: "var(--font-mono)",
					color: "var(--fg-primary)",
					backgroundColor: "var(--bg-primary)",
					border: `1px solid ${invalid ? "var(--error)" : "var(--border)"}`,
					outline: "none",
				}}
			/>
		</label>
	);
}

function IssueList({
	state,
	items,
	selected,
	onSelect,
}: {
	state: IssueState;
	items: GithubIssue[];
	selected: GithubIssue | null;
	onSelect: (issue: GithubIssue) => void;
}) {
	const message = (text: string, tone = "var(--fg-secondary)") => (
		<div style={{ padding: "14px 12px", fontSize: 12, color: tone }}>
			{text}
		</div>
	);
	if (state.status === "loading" || state.status === "idle")
		return message("Loading open issues…");
	if (state.status === "error") return message(state.message, "var(--error)");
	if (state.items.length === 0) return message("No open issues.");
	if (items.length === 0) return message("No issue matches.");
	return (
		<>
			{items.map((i, index) => {
				const isSel = i.number === selected?.number;
				return (
					<button
						key={i.number}
						type="button"
						data-index={index}
						onClick={() => onSelect(i)}
						className={`w-full flex items-center text-left ${
							isSel ? "" : "hover:bg-[var(--bg-tertiary)]"
						}`}
						style={{
							padding: "7px 12px",
							gap: 10,
							cursor: "pointer",
							background: isSel
								? "color-mix(in srgb, var(--accent) 16%, transparent)"
								: undefined,
							boxShadow: isSel ? "inset 2px 0 0 var(--accent)" : undefined,
						}}
					>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11.5,
								color: "var(--fg-secondary)",
								minWidth: 40,
							}}
						>
							#{i.number}
						</span>
						<span
							className="truncate flex-1"
							style={{
								fontSize: 13,
								color: "var(--fg-primary)",
								fontWeight: isSel ? 600 : 400,
							}}
						>
							{i.title}
						</span>
						{i.assignedToMe && (
							<span
								style={{
									fontSize: 9.5,
									fontWeight: 600,
									letterSpacing: "0.06em",
									textTransform: "uppercase",
									color: "var(--accent)",
									flexShrink: 0,
								}}
							>
								Yours
							</span>
						)}
					</button>
				);
			})}
		</>
	);
}
