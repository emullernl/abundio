import { create } from "zustand";
import {
	checkHandle,
	type HandleCheck,
	normalizeHandle,
} from "../lib/agentHandle";
import { raiseFileWindows } from "../lib/fileWindowRaise";
import {
	agentControl as agentControlApi,
	fileWindows,
	pty,
	tabs as tabsApi,
	workspaces as workspacesApi,
	worktrees as worktreesApi,
} from "../lib/ipc";
import {
	collectPaneIds,
	collectTerminalIds,
	containsPane,
	extractNode,
	findFilePaneInTree,
	findNode,
	insertBesideNode,
	parseTabLayout,
	pruneOrphanDerived,
	replaceNode,
	setAgentHandle,
	setAgentId,
	setAgentSessionId,
	setCwd,
} from "../lib/paneTree";
import { setPendingAgent, setPendingTask } from "../lib/pendingAgentRegistry";
import { perfMark } from "../lib/perfMarks";
import {
	countAgentPanesByFolder,
	relaunchCommandForPane,
	terminalNodes,
} from "../lib/sessionResume";
import { FIRST_TAB_NAME, nextTabName } from "../lib/tabName";
import { teardownTerminal } from "../lib/terminalManager";
import type {
	CodingAgent,
	PaneNode,
	PtyStatusType,
	Tab,
	WorkspaceWithTabs,
	WorktreeEntry,
} from "../lib/types";
import { isOrchestrator } from "../lib/workspaceKind";
import {
	forgetOpened,
	pickActive,
	rememberActive,
} from "../lib/workspaceRestore";
import { useExplorerStore } from "./explorerStore";
import { useNotesStore } from "./notesStore";
import { useOrchestratorStore } from "./orchestratorStore";
import { fallbackProfileId } from "./profileStore";
import { usePtyActivityStore } from "./ptyActivityStore";
import { useSettingsStore } from "./settingsStore";
import { useWorkspaceGitStore } from "./workspaceGitStore";

/** The one Missing folder refresh in flight, if any. */
let refreshInFlight: Promise<void> | null = null;

/** The body of `refreshMissingFolders`. */
async function runMissingFolderRefresh(): Promise<void> {
	const get = useWorkspaceStore.getState;
	const set = useWorkspaceStore.setState;
	const profileId = fallbackProfileId();
	const next = await fetchMissingFolders(profileId);
	if (!next || fallbackProfileId() !== profileId) return;
	const prev = get().missingFolderIds;
	const back = [...prev].filter((id) => !next.has(id));
	const changed = back.length > 0 || [...next].some((id) => !prev.has(id));
	if (changed) set({ missingFolderIds: next });
	if (back.length === 0) return;
	const opened = () => usePtyActivityStore.getState().openedWorkspaceIds;
	// Shown in the panel: it opens in place.
	const active = get().activeWorkspaceId;
	if (active && back.includes(active) && !opened().has(active)) {
		get().setActiveWorkspace(active);
	}
	// On the restore list: finish the restore the missing folder
	// interrupted, in the background.
	if (!useSettingsStore.getState().reopenWorkspacesOnOpen) return;
	let restore: Awaited<ReturnType<typeof workspacesApi.restoreSet>>;
	try {
		restore = await workspacesApi.restoreSet(profileId);
	} catch (err) {
		console.warn("[abundio] workspace restore: read failed", err);
		return;
	}
	if (fallbackProfileId() !== profileId) return;
	for (const id of restore.opened) {
		if (back.includes(id) && !opened().has(id)) {
			usePtyActivityStore.getState().markWorkspaceOpened(id);
		}
	}
}

/** The Profile's Missing-folder ids, or `null` when the check failed (a
 *  failure must leave the current marks alone, not clear them). */
async function fetchMissingFolders(
	profileId: string,
): Promise<Set<string> | null> {
	try {
		return new Set(await workspacesApi.missingFolders(profileId));
	} catch (err) {
		console.warn("[abundio] missing folder check failed", err);
		return null;
	}
}

/**
 * **Workspace restore** (ADR-0052): reopen the Workspaces the Profile had
 * Opened and make its Active one Active again. Runs at the end of every
 * `loadWorkspaces` — Window start and Switch Profile alike. Does nothing when
 * the setting is off, or when the Window already has an Active workspace.
 *
 * The Active one goes first: `TerminalPool` spawns its terminals at once and
 * the others' a moment later, so the one you look at is ready first.
 */
function orchestratorIsActive(): boolean {
	const s = useWorkspaceStore.getState();
	return isOrchestrator(s.workspaces.find((w) => w.id === s.activeWorkspaceId));
}

/** An Active workspace the user chose, which restore must not override. The
 *  Orchestrator workspace being Active is not a choice of that kind. */
function userPickedActive(): boolean {
	return (
		!!useWorkspaceStore.getState().activeWorkspaceId && !orchestratorIsActive()
	);
}

async function restoreOpenedWorkspaces(profileId: string): Promise<void> {
	if (!useSettingsStore.getState().reopenWorkspacesOnOpen) return;
	if (userPickedActive()) return;
	let set: Awaited<ReturnType<typeof workspacesApi.restoreSet>>;
	try {
		set = await workspacesApi.restoreSet(profileId);
	} catch (err) {
		console.warn("[abundio] workspace restore: read failed", err);
		return;
	}
	const store = useWorkspaceStore.getState();
	// The Profile may have changed, or the user picked a Workspace, while the
	// read was in flight.
	if (fallbackProfileId() !== profileId || userPickedActive()) return;
	const known = new Set(store.workspaces.map((w) => w.id));
	const opened = set.opened.filter((id) => known.has(id));
	const active = pickActive({ opened, active: set.active });
	if (active) {
		// The Orchestrator view, restored at launch, may already hold the
		// Active slot (ADR-0057): the restored one is where it hands back to.
		if (orchestratorIsActive()) {
			useOrchestratorStore.getState().set({ returnWorkspaceId: active });
		} else {
			store.setActiveWorkspace(active);
		}
	}
	const activity = usePtyActivityStore.getState();
	for (const id of opened) activity.markWorkspaceOpened(id);
}

/** What a **New task** hands the store to start its Agent: the argv with the
 *  prompt as one element (`agentTaskArgvFor`), and the Tab's name. */
export interface TaskSeed {
	argv: string[];
	agentId: string;
	tabName: string;
	/** Told which pane the task was seeded into, so the caller can follow it
	 *  (the Fleet Console expects its tile). */
	onSeeded?: (paneId: string) => void;
}

/** `ws` with one Tab renamed, without touching the original objects. */
function withTabName(
	ws: WorkspaceWithTabs,
	tabId: string,
	name: string,
): WorkspaceWithTabs {
	return {
		...ws,
		tabs: ws.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
	};
}

interface WorkspaceState {
	workspaces: WorkspaceWithTabs[];
	activeWorkspaceId: string | null;
	switchingWorkspaceId: string | null;
	/** Workspaces whose folder is missing right now (**Missing folder**,
	 *  ADR-0053). Refreshed when the list loads and when the Window gets
	 *  focus. Such a Workspace can be Active without being Opened. */
	missingFolderIds: Set<string>;
	/** Re-check which folders are missing. A Workspace whose folder came
	 *  back reopens: in place if it is Active, in the background if it is on
	 *  its Profile's restore list. */
	refreshMissingFolders: () => Promise<void>;
	activeTabByWorkspace: Record<string, string>; // workspaceId → active tabId
	focusedPaneId: string | null;
	focusedPaneByTab: Record<string, string>; // tabId → last focused paneId
	ptyStatuses: Record<string, PtyStatusType>; // ptyId → status
	searchPaneId: string | null; // pane currently showing search bar
	workspacesInitialized: boolean; // true after initial loadWorkspaces() completes

	// Workspace actions
	loadWorkspaces: () => Promise<void>;
	createWorkspace: (
		name: string,
		rootFolder: string,
		agent?: CodingAgent,
	) => Promise<WorkspaceWithTabs>;
	/** Create + activate a Workspace for a freshly created worktree, seeding its
	 *  focal terminal with the primary's setup commands then the chosen agent. */
	addWorktreeWorkspace: (
		entry: WorktreeEntry,
		setupCommands: string,
		agent?: CodingAgent,
		opts?: { background?: boolean; task?: TaskSeed },
	) => Promise<WorkspaceWithTabs>;
	/** Create the worktree on disk (worktrees.add) then create + activate its
	 *  Workspace — one awaitable op so the sidebar can show a single waiting
	 *  indicator over the whole (potentially slow) operation. */
	createWorktreeWorkspace: (
		primaryCwd: string,
		branch: string,
		absolutePath: string,
		setupCommands: string,
		agent?: CodingAgent,
		/** `background`: open the new Workspace without making it Active — the
		 *  Fleet Console starts Agents without rearranging the Workspace view.
		 *  `task`: start `agent` on a **New task** (setup commands then run
		 *  inside the task's shell, ahead of the Agent — ADR-0042). */
		opts?: { background?: boolean; task?: TaskSeed },
	) => Promise<WorkspaceWithTabs>;
	/** Add a discovered worktree as an unopened Workspace (no PTY, no agent),
	 *  deduped by folder. Used by sibling expansion and live reconcile. */
	addDiscoveredWorktree: (
		name: string,
		rootFolder: string,
	) => Promise<WorkspaceWithTabs | null>;
	/** Kill the worktree Workspace's PTYs, prune the worktree on disk (keeping
	 *  the branch), then remove the entry; focus falls back to the primary. */
	removeWorktreeWorkspace: (
		workspaceId: string,
		primaryCwd: string,
		worktreePath: string,
	) => Promise<void>;
	deleteWorkspace: (id: string) => Promise<void>;
	/** Close a Workspace: kill its PTYs and close its File windows. By default
	 *  it is also taken off its Profile's **Workspace restore** list, because
	 *  the user closed it. Profile switch passes `{ forget: false }`: the
	 *  Workspace must come back when the Profile is opened again (ADR-0052). */
	closeWorkspace: (id: string, opts?: { forget?: boolean }) => Promise<void>;
	renameWorkspace: (id: string, name: string) => Promise<void>;
	setWorktreeSetupCommands: (id: string, commands: string) => Promise<void>;
	setActiveWorkspace: (id: string | null) => void;
	beginWorkspaceSwitch: (id: string | null) => void;

	reorderWorkspaces: (ids: string[]) => void;

	// Tab actions
	createTab: (
		workspaceId: string,
		agent?: CodingAgent,
		seedLayout?: PaneNode,
		/** `activate: false` appends the Tab without making it the Workspace's
		 *  active Tab or moving focus — the Fleet Console's New agent, which must
		 *  not rearrange the Workspace view (ADR-0040). Defaults to true.
		 *  `task`: start `agent` on a **New task**, in a Tab named after it.
		 *  `name`: the Tab's name, over every default.
		 *  `spawn`: opened by Agent control (ADR-0054); its pane is a
		 *  **Spawned pane** of `ownerPaneId`, with `handle` as its Agent
		 *  handle. */
		opts?: {
			activate?: boolean;
			task?: TaskSeed;
			name?: string;
			spawn?: { ownerPaneId: string; handle?: string };
		},
	) => Promise<Tab>;
	closeTab: (tabId: string) => Promise<void>;
	setActiveTab: (workspaceId: string, tabId: string) => void;
	renameTab: (tabId: string, name: string) => Promise<void>;

	// Pane/layout actions
	setFocusedPane: (paneId: string | null) => void;
	stampAgentOnPane: (paneId: string, agentId: string | undefined) => void;
	/** Remember an **Agent session id** on a pane running `agentId`. No write
	 *  when it is already the pane's id, or the pane runs no such Agent. */
	stampAgentSessionOnPane: (
		paneId: string,
		agentId: string,
		sessionId: string,
	) => void;
	stampCwdOnPane: (paneId: string, cwd: string) => void;
	/** Name the Agent in `paneId`: its **Agent handle**, checked for grammar
	 *  and (by Rust) for uniqueness in its Profile (ADR-0055). `null` clears
	 *  it, and an Agent pane then gets a **Default handle** back. */
	setAgentHandle: (
		paneId: string,
		handle: string | null,
	) => Promise<HandleCheck>;
	/** Give an Agent pane with no handle the lowest free **Default handle**.
	 *  Does nothing for a pane that has one, or that runs no Agent. */
	ensureDefaultHandle: (paneId: string) => Promise<void>;
	updateLayout: (tabId: string, layout: PaneNode) => Promise<void>;
	updateLayoutLocal: (tabId: string, layout: PaneNode) => void;
	persistLayout: (tabId: string) => Promise<void>;
	setPtyStatus: (ptyId: string, status: PtyStatusType) => void;
	/** Toggle the terminal find bar on `paneId`, or on the Focused pane. */
	toggleSearch: (paneId?: string | null) => void;
	setWorkspaceBaseBranch: (
		workspaceId: string,
		baseBranch: string | null,
	) => void;

	movePaneToTarget: (
		sourceTabId: string,
		sourcePaneId: string,
		target:
			| {
					kind: "pane-edge";
					tabId: string;
					paneId: string;
					edge: "top" | "right" | "bottom" | "left";
			  }
			| { kind: "new-tab" },
	) => Promise<void>;

	// Derived
	getActiveWorkspace: () => WorkspaceWithTabs | undefined;
	/** The Workspace owning `paneId`, searched across every opened workspace —
	 *  not just the active one. */
	findWorkspaceForPane: (paneId: string) => WorkspaceWithTabs | null;
	getActiveTab: () => Tab | undefined;
	getActiveLayout: () => PaneNode | null;
	getTabsForWorkspace: (workspaceId: string) => Tab[];
}

function defaultLayout(): PaneNode {
	return { type: "terminal", id: crypto.randomUUID(), ptyId: "" };
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Find the worktree whose root contains the picked folder (longest prefix). */
function findFocalWorktree(
	entries: WorktreeEntry[],
	picked: string,
): WorktreeEntry | null {
	let best: WorktreeEntry | null = null;
	for (const e of entries) {
		const root = e.path;
		const prefix = root.endsWith("/") ? root : `${root}/`;
		if (picked === root || picked.startsWith(prefix)) {
			if (!best || e.path.length > best.path.length) best = e;
		}
	}
	return best;
}

/**
 * Seed the focal terminal pane's pending command: the primary's setup commands
 * (one per line) followed by the chosen agent's launch command. The shell
 * serializes them, so setup runs first and the agent starts after. Also stamps
 * the agent id into the layout so it survives restarts. Returns the focal tab
 * and pane ids. See ADR-0017.
 */
function seedFocalPane(
	ws: WorkspaceWithTabs,
	opts: { setupCommands?: string; agent?: CodingAgent; task?: TaskSeed },
): {
	firstTabId: string | undefined;
	firstPaneId: string | null;
	/** The name the focal Tab must take (a task's), for the caller to apply
	 *  through `set` — never by mutating a Tab the store may already hold. */
	tabName?: string;
} {
	const firstTab = ws.tabs[0];
	const firstTabId = firstTab?.id;
	let firstPaneId: string | null = null;
	let tabName: string | undefined;
	if (!firstTab) return { firstTabId, firstPaneId };
	try {
		const layout = parseTabLayout(firstTab.layoutJson);
		if (!layout) return { firstTabId, firstPaneId };
		firstPaneId = collectTerminalIds(layout)[0] ?? null;
		const setupLines = (opts.setupCommands ?? "")
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		const agentCmd = opts.agent
			? [opts.agent.command, ...(opts.agent.args ?? [])].join(" ")
			: null;
		const combined = [...setupLines, ...(agentCmd ? [agentCmd] : [])].join(
			"\n",
		);
		if (firstPaneId && opts.task) {
			setPendingTask(firstPaneId, {
				argv: opts.task.argv,
				agentId: opts.task.agentId,
				setup: setupLines.length ? setupLines.join("\n") : undefined,
			});
			tabsApi
				.update(firstTab.id, { name: opts.task.tabName })
				.catch((err) => console.error("[newTask] tab rename failed:", err));
			opts.task.onSeeded?.(firstPaneId);
			tabName = opts.task.tabName;
		} else if (firstPaneId && combined) {
			setPendingAgent(firstPaneId, { command: combined });
		}
		if (opts.agent && firstPaneId) {
			const stamped = setAgentId(layout, firstPaneId, opts.agent.id);
			const stampedJson = JSON.stringify(stamped);
			firstTab.layoutJson = stampedJson;
			tabsApi.update(firstTab.id, { layoutJson: stampedJson }).catch(() => {});
		}
	} catch {
		/* malformed layout — skip seeding */
	}
	return { firstTabId, firstPaneId, tabName };
}

/** Clear all ptyIds in a layout tree so fresh PTYs get spawned on render. */
function clearPtyIds(node: PaneNode): PaneNode {
	if (node.type === "terminal") {
		return { ...node, ptyId: "" };
	}
	if (node.type !== "split") return node;
	return {
		...node,
		first: clearPtyIds(node.first),
		second: clearPtyIds(node.second),
	};
}

/**
 * For each terminal pane in the layout that has an agentId, seed
 * pendingAgentRegistry so the agent re-runs the next time the pane spawns its
 * PTY — resuming its last session when it can (**Session resume**, ADR-0050).
 * `counts` is `countAgentPanesByFolder` over every loaded Workspace. Agents
 * that no longer exist are skipped — the pane comes up as a plain shell.
 */
function seedPendingAgentsForLayout(
	layout: PaneNode,
	rootFolder: string,
	counts: Map<string, number>,
): void {
	for (const node of terminalNodes(layout)) {
		const command = relaunchCommandForPane(node, rootFolder, counts);
		if (!command) continue;
		setPendingAgent(node.id, { command });
	}
}

/**
 * The pane to focus when a Tab comes on screen: the one it last had focused,
 * if that pane is still in its layout, else its first pane. The remembered
 * pane can be gone — closed from a Fleet tile while its Tab was not the
 * active one — and restoring it would leave nothing focused while pane
 * shortcuts acted on a pane that no longer exists. Exported for tests.
 */
export function restoreTabFocus(
	workspaces: WorkspaceWithTabs[],
	workspaceId: string,
	tabId: string,
	focusedPaneByTab: Record<string, string>,
): string | null {
	const tab = workspaces
		.find((w) => w.id === workspaceId)
		?.tabs.find((t) => t.id === tabId);
	const layout = tab ? parseTabLayout(tab.layoutJson) : null;
	if (!layout) return null;
	const remembered = focusedPaneByTab[tabId];
	if (remembered && containsPane(layout, remembered)) return remembered;
	return collectPaneIds(layout)[0] ?? null;
}

/** Update a tab's layoutJson in the workspaces array (immutable). */
function updateTabInWorkspaces(
	workspaces: WorkspaceWithTabs[],
	tabId: string,
	layoutJson: string,
): WorkspaceWithTabs[] {
	return workspaces.map((s) => ({
		...s,
		tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, layoutJson } : t)),
	}));
}

/**
 * Walk every tab across every workspace, applying `mutate` to its parsed layout.
 * Returns the first tab whose layout actually changed (reference inequality —
 * relies on paneTree mutators returning the same node when nothing changed),
 * with its new layoutJson ready to persist. Returns null if none changed.
 */
export function findMutatedTabLayout(
	workspaces: WorkspaceWithTabs[],
	mutate: (layout: PaneNode) => PaneNode,
): { tabId: string; layoutJson: string } | null {
	for (const ws of workspaces) {
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			const stamped = mutate(layout);
			if (stamped !== layout) {
				return { tabId: tab.id, layoutJson: JSON.stringify(stamped) };
			}
		}
	}
	return null;
}

interface PersistedFileTab {
	id: string;
	filePath: string;
	fileName: string;
}
interface PersistedFileTabState {
	tabs: PersistedFileTab[];
	activeFileTabId: string | null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
	workspaces: [],
	activeWorkspaceId: null,
	switchingWorkspaceId: null,
	missingFolderIds: new Set(),
	activeTabByWorkspace: {},
	focusedPaneId: null,
	focusedPaneByTab: {},
	ptyStatuses: {},
	searchPaneId: null,
	workspacesInitialized: false,

	loadWorkspaces: async () => {
		const profileId = fallbackProfileId();
		const workspacesWithTabs = await workspacesApi.list(profileId);
		// Clear stale ptyIds from all tabs' layouts and re-seed pending agents
		// for any pane whose layout remembers an agentId from a previous session.
		const allPaneIds: string[] = [];
		const cleaned = workspacesWithTabs.map((s) => ({
			...s,
			tabs: s.tabs.map((t) => {
				const layout = parseTabLayout(t.layoutJson);
				if (!layout) return t;
				// Prune preview panes orphaned across sessions (their source pane
				// no longer exists) before clearing stale ptyIds.
				const pruned = pruneOrphanDerived(layout) ?? layout;
				allPaneIds.push(...collectPaneIds(pruned));
				const cleared = clearPtyIds(pruned);
				return { ...t, layoutJson: JSON.stringify(cleared) };
			}),
		}));
		// After every layout is cleaned: whether a pane may take its folder's
		// latest session depends on every other Workspace's panes.
		const counts = countAgentPanesByFolder(cleaned);
		for (const ws of cleaned) {
			// The Orchestrator starts when its view opens, through the spawn
			// (lib/orchestratorLaunch.ts), never by a typed relaunch line.
			if (isOrchestrator(ws)) continue;
			for (const t of ws.tabs) {
				const layout = parseTabLayout(t.layoutJson);
				if (layout) seedPendingAgentsForLayout(layout, ws.rootFolder, counts);
			}
		}

		// Set default active tab for each workspace
		const activeTabByWorkspace: Record<string, string> = {};
		for (const s of cleaned) {
			if (s.tabs.length > 0) {
				activeTabByWorkspace[s.id] = s.tabs[0].id;
			}
		}

		// Drop any active-workspace state that points at a workspace not in the
		// newly-loaded list. This is what makes profile switching clean: when
		// the new profile has different workspaces, the old active id is stale
		// and would otherwise leave the StatusBar / focused pane referencing a
		// workspace no longer in the store.
		const newIds = new Set(cleaned.map((w) => w.id));
		set((state) => ({
			workspaces: cleaned,
			activeTabByWorkspace,
			workspacesInitialized: true,
			activeWorkspaceId:
				state.activeWorkspaceId && newIds.has(state.activeWorkspaceId)
					? state.activeWorkspaceId
					: null,
			focusedPaneId: null,
		}));
		pty.cleanupStaleLogs(allPaneIds).catch(() => {});

		// Before the restore, so a Missing-folder Workspace is never picked
		// as the Active one. A fresh set: the previous Profile's ids mean
		// nothing here.
		const missing = await fetchMissingFolders(profileId);
		if (missing) set({ missingFolderIds: missing });

		await restoreOpenedWorkspaces(profileId);

		// Pre-populate branch chips from the persisted lastBranch so chips appear
		// immediately. The real branch name is fetched the first time each
		// workspace is activated (see setActiveWorkspace).
		const initialGitInfo: Record<
			string,
			import("./workspaceGitStore").WorkspaceGitInfo
		> = {};
		for (const ws of cleaned) {
			if (ws.lastBranch) {
				initialGitInfo[ws.id] = {
					isGitRepo: true,
					currentBranch: ws.lastBranch,
					changedFileCount: 0,
					// null, not []: git has not been asked yet, and an empty array
					// would read as "no conflicts" and tear down a restored Merge
					// view before the first fetch lands.
					conflictedPaths: null,
					additions: 0,
					deletions: 0,
				};
			}
		}
		if (Object.keys(initialGitInfo).length > 0) {
			useWorkspaceGitStore.setState((s) => ({
				byWorkspaceId: { ...s.byWorkspaceId, ...initialGitInfo },
			}));
		}

		// One-time migration: convert old fileTabsJson into file-leaf tabs
		for (const s of workspacesWithTabs) {
			if (!s.fileTabsJson || s.fileTabsJson === "{}") continue;
			try {
				const persisted: PersistedFileTabState = JSON.parse(s.fileTabsJson);
				if (!persisted.tabs?.length) continue;
				// Create a new tab for each previously-open file
				for (const ft of persisted.tabs) {
					const seedLayout: PaneNode = {
						type: "file",
						id: crypto.randomUUID(),
						filePath: ft.filePath,
					};
					await get().createTab(s.id, undefined, seedLayout);
				}
				// Clear fileTabsJson so migration doesn't re-run
				workspacesApi.update(s.id, { fileTabsJson: "" }).catch(() => {});
			} catch {
				// Malformed JSON — skip
			}
		}
	},

	createWorkspace: async (name, rootFolder, agent) => {
		const profileId = fallbackProfileId();

		// Worktree expansion: if the picked folder is part of a repo with ≥2
		// worktrees, snap the focal Workspace to its worktree root and add every
		// other worktree as an unopened sibling. See ADR-0017.
		let focalFolder = rootFolder;
		let siblings: WorktreeEntry[] = [];
		try {
			// Only real (existing) worktrees participate in expansion.
			const list = (await worktreesApi.list(rootFolder)).filter(
				(e) => e.exists,
			);
			if (list.length >= 2) {
				const focal = findFocalWorktree(list, rootFolder);
				if (focal) {
					focalFolder = focal.path;
					siblings = list.filter((e) => e.path !== focal.path);
				}
			}
		} catch {
			// Not a git repo / discovery failed — plain single create.
		}

		const workspaceWithTabs = await workspacesApi.create(
			name,
			focalFolder,
			profileId,
		);
		usePtyActivityStore.getState().markWorkspaceOpened(workspaceWithTabs.id);
		const { firstTabId, firstPaneId } = seedFocalPane(workspaceWithTabs, {
			agent,
		});
		set((state) => ({
			workspaces: [...state.workspaces, workspaceWithTabs],
			activeWorkspaceId: workspaceWithTabs.id,
			activeTabByWorkspace: firstTabId
				? {
						...state.activeTabByWorkspace,
						[workspaceWithTabs.id]: firstTabId,
					}
				: state.activeTabByWorkspace,
			focusedPaneId: firstPaneId ?? state.focusedPaneId,
		}));
		useWorkspaceGitStore
			.getState()
			.fetch(workspaceWithTabs.id, focalFolder, null)
			.catch(() => {});

		// Add sibling worktrees as unopened Workspaces (deduped against existing).
		for (const e of siblings) {
			await get().addDiscoveredWorktree(basename(e.path), e.path);
		}

		return workspaceWithTabs;
	},

	createWorktreeWorkspace: async (
		primaryCwd,
		branch,
		absolutePath,
		setupCommands,
		agent,
		opts,
	) => {
		// Disk-level git worktree add (slow on large repos), then the in-app
		// Workspace.
		const entry = await worktreesApi.add(primaryCwd, branch, absolutePath);
		try {
			return await get().addWorktreeWorkspace(
				entry,
				setupCommands,
				agent,
				opts,
			);
		} catch (e) {
			// The worktree exists on disk but registering its Workspace failed
			// (rare — local DB insert). Best-effort rollback so the user isn't left
			// with an orphan folder + stale `.git/worktrees` entry that would also
			// make a same-path "Edit & retry" fail with "target folder already
			// exists". If the rollback itself fails, they're no worse off than
			// before it; surface the original error either way.
			await worktreesApi.remove(primaryCwd, entry.path).catch(() => {});
			throw e;
		}
	},

	addWorktreeWorkspace: async (entry, setupCommands, agent, opts) => {
		const background = opts?.background ?? false;
		// The watcher commonly races this in during the slow `git worktree add`:
		// it fires `worktrees-changed`, and addDiscoveredWorktree creates a bare,
		// unopened Workspace for the new folder before we get here. That entry has
		// no agent or setup commands seeded, so just switching to it would silently
		// drop the user's "Launch with" choice and their configured setup commands.
		// This bites macOS hardest: many-small-file checkouts are slower on APFS,
		// so the checkout outruns the worktrees-changed debounce far more often.
		// Seed the focal pane first (unless it's somehow already open, where a
		// pending command would never be consumed), then activate.
		const existing = get().workspaces.find((w) => w.rootFolder === entry.path);
		if (existing) {
			const alreadyOpen = usePtyActivityStore
				.getState()
				.openedWorkspaceIds.has(existing.id);
			if (alreadyOpen && opts?.task && agent) {
				// Its focal pane already has a PTY, so a seed would never be
				// consumed and the task would vanish without a word. Start the
				// task in a new Tab of that Workspace instead.
				await get().createTab(existing.id, agent, undefined, {
					activate: !background,
					task: opts.task,
				});
			} else if (!alreadyOpen && (agent || setupCommands)) {
				const { firstTabId, tabName } = seedFocalPane(existing, {
					setupCommands,
					agent,
					task: opts?.task,
				});
				if (firstTabId && tabName) {
					set((state) => ({
						workspaces: state.workspaces.map((w) =>
							w.id === existing.id ? withTabName(w, firstTabId, tabName) : w,
						),
					}));
				}
			}
			if (background) {
				usePtyActivityStore.getState().markWorkspaceOpened(existing.id);
			} else {
				get().beginWorkspaceSwitch(existing.id);
			}
			return existing;
		}
		const profileId = fallbackProfileId();
		const created = await workspacesApi.create(
			basename(entry.path),
			entry.path,
			profileId,
		);
		usePtyActivityStore.getState().markWorkspaceOpened(created.id);
		const { firstTabId, firstPaneId, tabName } = seedFocalPane(created, {
			setupCommands,
			agent,
			task: opts?.task,
		});
		const ws =
			firstTabId && tabName
				? withTabName(created, firstTabId, tabName)
				: created;
		set((state) => ({
			workspaces: [...state.workspaces, ws],
			activeWorkspaceId: background ? state.activeWorkspaceId : ws.id,
			activeTabByWorkspace: firstTabId
				? { ...state.activeTabByWorkspace, [ws.id]: firstTabId }
				: state.activeTabByWorkspace,
			focusedPaneId: background
				? state.focusedPaneId
				: (firstPaneId ?? state.focusedPaneId),
		}));
		useWorkspaceGitStore
			.getState()
			.fetch(ws.id, entry.path, null)
			.catch(() => {});
		return ws;
	},

	addDiscoveredWorktree: async (name, rootFolder) => {
		// Dedup by folder — never create a second entry for the same worktree.
		if (get().workspaces.some((w) => w.rootFolder === rootFolder)) {
			return null;
		}
		const profileId = fallbackProfileId();
		const ws = await workspacesApi.create(name, rootFolder, profileId);
		// Unopened: not marked opened, not activated, no PTY, no agent. We still
		// record the active tab so switching to it later renders the first tab —
		// mirrors loadWorkspaces' default. Without this, activeTabByWorkspace[id]
		// is undefined and no tab content shows until an app restart.
		const firstTabId = ws.tabs[0]?.id;
		set((state) => ({
			workspaces: [...state.workspaces, ws],
			activeTabByWorkspace: firstTabId
				? { ...state.activeTabByWorkspace, [ws.id]: firstTabId }
				: state.activeTabByWorkspace,
		}));
		useWorkspaceGitStore
			.getState()
			.fetch(ws.id, rootFolder, null)
			.catch(() => {});
		return ws;
	},

	removeWorktreeWorkspace: async (workspaceId, primaryCwd, worktreePath) => {
		const wasActive = get().activeWorkspaceId === workspaceId;
		// Prune the worktree on disk FIRST, while the workspace is still intact
		// (PTYs alive, layout untouched). If this throws — locked worktree, EBUSY,
		// permission denied — the workspace keeps its live session instead of being
		// left half-torn-down. Only on success do we kill PTYs and remove the entry.
		// The brief window where a shell's cwd is unlinked before we kill it is
		// harmless on the platforms we target. See ADR-0017.
		await worktreesApi.remove(primaryCwd, worktreePath);
		await get().closeWorkspace(workspaceId);
		await get().deleteWorkspace(workspaceId);
		if (wasActive) {
			const primary = get().workspaces.find((w) => w.rootFolder === primaryCwd);
			if (primary) get().beginWorkspaceSwitch(primary.id);
		}
	},

	deleteWorkspace: async (id) => {
		const workspace = get().workspaces.find((s) => s.id === id);
		if (workspace) {
			// Permanently tear down every pane across all tabs — kills PTYs, stops
			// background trackers, and purges activity entries so the Overview bar
			// counts drop even for a direct delete that skipped closeWorkspace
			// (e.g. sidebar bulk-delete, worktree sync). Idempotent if
			// closeWorkspace already ran. See ADR-0020.
			for (const tab of workspace.tabs) {
				const layout = parseTabLayout(tab.layoutJson);
				if (!layout) continue;
				for (const paneId of collectPaneIds(layout)) {
					teardownTerminal(paneId);
				}
			}
		}
		// Drop any pending debounced note save — the note row is cascade-deleted
		// with the workspace, so letting the timer fire would error on a missing FK.
		useNotesStore.getState().cancelPendingSave(id);
		// Close its File windows while their rows still name them; the
		// delete then cascades the rows away (ADR-0046).
		await fileWindows.close([id]).catch(() => {});
		await workspacesApi.delete(id);
		usePtyActivityStore.getState().unmarkWorkspaceOpened(id);
		useWorkspaceGitStore.getState().remove(id);
		set((state) => ({
			workspaces: state.workspaces.filter((s) => s.id !== id),
			activeWorkspaceId:
				state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
		}));
	},

	closeWorkspace: async (id, opts) => {
		const state = get();
		const workspace = state.workspaces.find((s) => s.id === id);
		if (!workspace) return;
		if (opts?.forget ?? true) forgetOpened(id);

		const activityStore = usePtyActivityStore.getState();

		// Permanently tear down every pane: kill PTYs, stop background trackers,
		// and purge activity entries so the Overview bar counts drop (ADR-0020).
		for (const tab of workspace.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			for (const paneId of collectPaneIds(layout)) {
				teardownTerminal(paneId);
			}
			// Clean up file pane state
			useExplorerStore.getState().clearWorkspaceFilePanes(id);
		}

		// Reset dot to grey
		activityStore.unmarkWorkspaceOpened(id);

		// Its File windows close with it and are remembered, to reopen with
		// it. Unsaved edits were asked about by the caller (ADR-0046).
		fileWindows.close([id]).catch(() => {});

		// Clear ptyIds from layouts so fresh PTYs spawn on next open, and re-seed
		// pendingAgentRegistry for any pane that remembers an agent.
		const isActive = state.activeWorkspaceId === id;
		const counts = countAgentPanesByFolder(state.workspaces);
		set({
			workspaces: state.workspaces.map((s) =>
				s.id === id
					? {
							...s,
							tabs: s.tabs.map((t) => {
								const layout = parseTabLayout(t.layoutJson);
								if (!layout) return t;
								const cleared = clearPtyIds(layout);
								if (!isOrchestrator(s)) {
									seedPendingAgentsForLayout(cleared, s.rootFolder, counts);
								}
								return {
									...t,
									layoutJson: JSON.stringify(cleared),
								};
							}),
						}
					: s,
			),
			activeWorkspaceId: isActive ? null : state.activeWorkspaceId,
			focusedPaneId: isActive ? null : state.focusedPaneId,
		});
	},

	renameWorkspace: async (id, name) => {
		await workspacesApi.update(id, { name });
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === id ? { ...s, name } : s,
			),
		}));
	},

	setWorktreeSetupCommands: async (id, commands) => {
		await workspacesApi.update(id, { worktreeSetupCommands: commands });
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === id ? { ...s, worktreeSetupCommands: commands } : s,
			),
		}));
	},

	setActiveWorkspace: (id) => {
		perfMark("abundio:switch-workspace");
		// Order matters: marking Opened first starts the File window
		// restore, which the raise (heard on the `activeWorkspaceId` change
		// below) waits on. Swapped, the raise finds no windows on a Workspace's
		// first activation. Covered by useFileWindowRaise.test.tsx.
		// A Missing folder is Active but not Opened (ADR-0053): it shows the
		// "Folder not found" panel and starts nothing, so it is neither marked
		// Opened nor remembered as the Profile's Active workspace. One that was
		// already Opened when its folder vanished still has its panes on
		// screen, so it is remembered like any other — the same test App.tsx
		// uses for the panel.
		const missing =
			!!id &&
			get().missingFolderIds.has(id) &&
			!usePtyActivityStore.getState().openedWorkspaceIds.has(id);
		// The Orchestrator workspace is Active only while its view is on
		// screen, so it is never the Workspace a Profile reopens on (ADR-0057).
		const orchestrator = isOrchestrator(
			id ? get().workspaces.find((w) => w.id === id) : null,
		);
		if (id && !missing) {
			usePtyActivityStore.getState().markWorkspaceOpened(id);
			if (!orchestrator) rememberActive(fallbackProfileId(), id);
		}
		set((state) => {
			const focusedPaneByTab = { ...state.focusedPaneByTab };
			// Save current focused pane for the current tab
			const currentWorkspaceId = state.activeWorkspaceId;
			if (currentWorkspaceId && state.focusedPaneId) {
				const currentTabId = state.activeTabByWorkspace[currentWorkspaceId];
				if (currentTabId) {
					focusedPaneByTab[currentTabId] = state.focusedPaneId;
				}
			}
			// Restore focused pane for the new workspace's active tab
			const newTabId = id ? state.activeTabByWorkspace[id] : undefined;
			const restoredFocus =
				id && newTabId
					? restoreTabFocus(state.workspaces, id, newTabId, focusedPaneByTab)
					: null;
			return {
				activeWorkspaceId: id,
				focusedPaneId: restoredFocus,
				focusedPaneByTab,
			};
		});
		// Fetch real branch name and change stats for the newly active workspace.
		// Deferred so the workspace UI (terminals, layout) renders first.
		// Skipped for a Missing folder: there is no repository to ask.
		if (id && !missing && !orchestrator) {
			setTimeout(() => {
				const ws = get().workspaces.find((s) => s.id === id);
				if (ws) {
					useWorkspaceGitStore
						.getState()
						.fetch(id, ws.rootFolder, ws.baseBranch)
						.catch(() => {});
				}
			}, 500);
		}
	},

	beginWorkspaceSwitch: (id) => {
		// Any new switch supersedes a slow-path switch still waiting on its
		// frames — clearing `switchingWorkspaceId` makes that pending callback
		// bail. Without this a Workspace cycle pressed within ~2 frames of a
		// click was reverted by the click's switch landing afterwards.
		if (id === get().activeWorkspaceId) {
			if (get().switchingWorkspaceId !== null)
				set({ switchingWorkspaceId: null });
			// Selecting the Active workspace again still raises its Markdown
			// windows (GLOSSARY.md); the hook only hears real changes.
			if (id) void raiseFileWindows(id);
			return;
		}
		// Fast path: already mounted — switch instantly with no overlay. A
		// Missing folder has nothing to mount, so it takes this path too.
		if (
			id &&
			(usePtyActivityStore.getState().openedWorkspaceIds.has(id) ||
				get().missingFolderIds.has(id))
		) {
			set({ switchingWorkspaceId: null });
			get().setActiveWorkspace(id);
			return;
		}
		// Slow path: pre-mount the target workspace's DOM behind the overlay,
		// then flip once React has committed the new subtree (~2 frames).
		// Marking Opened before the flip also keeps the File window restore
		// ahead of the raise (see setActiveWorkspace).
		if (id) usePtyActivityStore.getState().markWorkspaceOpened(id);
		set({ switchingWorkspaceId: id });
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (get().switchingWorkspaceId !== id) return;
				get().setActiveWorkspace(id);
				set({ switchingWorkspaceId: null });
			});
		});
	},

	refreshMissingFolders: () => {
		// One check at a time: on a hung mount each one can take long, and a
		// burst of focus changes would otherwise stack them up.
		refreshInFlight ??= runMissingFolderRefresh().finally(() => {
			refreshInFlight = null;
		});
		return refreshInFlight;
	},

	reorderWorkspaces: (ids) => {
		const previous = get().workspaces;
		const byId = new Map(previous.map((s) => [s.id, s]));
		// `ids` need not be the complete set: anything omitted keeps its relative
		// order after the listed ids, so no workspace is dropped from state and no
		// two end up sharing a `position`.
		const listed = new Set(ids);
		const ordered = [
			...ids
				.map((id) => byId.get(id))
				.filter((w): w is WorkspaceWithTabs => w !== undefined),
			...previous.filter((w) => !listed.has(w.id)),
		];
		// `position` — not array order — is what the sidebar sorts rows by
		// (`buildWorkspaceRows`), so it must be restamped here to match what the
		// backend writes (position = index), otherwise the drop snaps back.
		// Unmoved workspaces keep their identity so their rows don't re-render.
		const reordered = ordered.map((w, i) =>
			w.position === i ? w : { ...w, position: i },
		);
		set({ workspaces: reordered });
		// Persist the full order, not just `ids` — the backend stamps only the ids
		// it receives, so a partial list would leave stale positions in the DB.
		workspacesApi.reorder(reordered.map((w) => w.id)).catch(() => {
			// The write failed, so the DB still holds the old order. Roll the UI
			// back rather than showing an order that would vanish on restart.
			if (get().workspaces === reordered) set({ workspaces: previous });
		});
	},

	// ── Tab actions ──

	createTab: async (workspaceId, agent, seedLayout, opts) => {
		const activate = opts?.activate ?? true;
		const workspace = get().workspaces.find((s) => s.id === workspaceId);

		// The seed layout may be a bare file leaf, or — for markdown files opened
		// with an auto-opened preview — a split containing the file pane.
		const seedFilePane = seedLayout ? findFilePaneInTree(seedLayout) : null;
		let name: string;
		if (opts?.name) {
			name = opts.name;
		} else if (seedFilePane) {
			name = seedFilePane.filePath.split("/").pop() || "file";
		} else if (opts?.task) {
			name = opts.task.tabName;
		} else if (agent) {
			name = agent.name;
		} else {
			name = nextTabName(workspace?.tabs.map((t) => t.name) ?? []);
		}

		const tab = await tabsApi.create(workspaceId, name);

		// If caller provided a seed layout (e.g. a file leaf), override the default terminal layout.
		let finalLayout: PaneNode;
		if (seedLayout) {
			finalLayout = seedLayout;
			const layoutJson = JSON.stringify(finalLayout);
			tab.layoutJson = layoutJson;
			tabsApi.update(tab.id, { layoutJson }).catch(() => {});
		} else {
			finalLayout = parseTabLayout(tab.layoutJson) ?? defaultLayout();
		}

		let initialFocus: string | null = collectPaneIds(finalLayout)[0] ?? null;

		if (agent && !seedLayout) {
			const terminalFocus = collectTerminalIds(finalLayout)[0] ?? null;
			if (terminalFocus) {
				if (opts?.task) {
					setPendingTask(terminalFocus, {
						argv: opts.task.argv,
						agentId: opts.task.agentId,
					});
					opts.task.onSeeded?.(terminalFocus);
				} else {
					setPendingAgent(terminalFocus, {
						command: [agent.command, ...(agent.args ?? [])].join(" "),
					});
				}
				// Persist the agent identity into the layout so it survives restarts.
				const stamped = setAgentId(finalLayout, terminalFocus, agent.id);
				const stampedJson = JSON.stringify(stamped);
				tab.layoutJson = stampedJson;
				tabsApi.update(tab.id, { layoutJson: stampedJson }).catch(() => {});
				initialFocus = terminalFocus;
			}
		}

		// Opened by Agent control: the owner on its pane (a **Spawned pane**),
		// written before the Tab reaches the store, so nothing can render (and
		// spawn) without it.
		if (opts?.spawn && !seedLayout) {
			const { ownerPaneId, handle } = opts.spawn;
			const layout = parseTabLayout(tab.layoutJson) ?? finalLayout;
			const paneId = collectTerminalIds(layout)[0];
			const node = paneId ? findNode(layout, paneId) : null;
			if (node?.type === "terminal") {
				const owned = replaceNode(layout, node.id, {
					...node,
					spawnedBy: ownerPaneId,
					...(handle ? { agentHandle: handle } : {}),
				});
				tab.layoutJson = JSON.stringify(owned);
			}
			tabsApi.update(tab.id, { layoutJson: tab.layoutJson }).catch(() => {});
		}

		if (!activate) {
			set((state) => ({
				workspaces: state.workspaces.map((s) =>
					s.id === workspaceId ? { ...s, tabs: [...s.tabs, tab] } : s,
				),
				// A Workspace with no active Tab yet (never opened) still needs one,
				// or it renders nothing when it is later switched to.
				activeTabByWorkspace: state.activeTabByWorkspace[workspaceId]
					? state.activeTabByWorkspace
					: { ...state.activeTabByWorkspace, [workspaceId]: tab.id },
			}));
			return tab;
		}

		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspaceId ? { ...s, tabs: [...s.tabs, tab] } : s,
			),
			activeTabByWorkspace: {
				...state.activeTabByWorkspace,
				[workspaceId]: tab.id,
			},
			focusedPaneId: initialFocus,
		}));
		return tab;
	},

	closeTab: async (tabId) => {
		const state = get();
		// Find which workspace owns this tab
		const workspace = state.workspaces.find((s) =>
			s.tabs.some((t) => t.id === tabId),
		);
		if (!workspace) return;

		const tabIndex = workspace.tabs.findIndex((t) => t.id === tabId);
		const tab = workspace.tabs[tabIndex];

		// Permanently tear down every pane in this tab — kills PTYs, stops
		// background trackers, and purges activity entries so the Overview bar
		// counts drop (ADR-0020). File-pane explorer state is cleared alongside.
		if (tab) {
			const layout = parseTabLayout(tab.layoutJson);
			if (layout) {
				for (const paneId of collectPaneIds(layout)) {
					teardownTerminal(paneId);
					useExplorerStore.getState().unregisterFilePane(paneId);
				}
			}
		}

		// If this is the last tab, create a new one instead of closing
		if (workspace.tabs.length <= 1) {
			const newTab = await tabsApi.create(workspace.id, FIRST_TAB_NAME);
			await tabsApi.delete(tabId);
			set((state) => ({
				workspaces: state.workspaces.map((s) =>
					s.id === workspace.id ? { ...s, tabs: [newTab] } : s,
				),
				activeTabByWorkspace: {
					...state.activeTabByWorkspace,
					[workspace.id]: newTab.id,
				},
				// Only the Workspace on screen owns focus: a Fleet tile can close a
				// background Workspace's last pane (ADR-0040).
				focusedPaneId:
					state.activeWorkspaceId === workspace.id ? null : state.focusedPaneId,
			}));
			return;
		}

		await tabsApi.delete(tabId);

		// Pick the next active tab
		const remainingTabs = workspace.tabs.filter((t) => t.id !== tabId);
		const currentActiveTabId = state.activeTabByWorkspace[workspace.id];
		let newActiveTabId = currentActiveTabId;
		if (currentActiveTabId === tabId) {
			// Activate the tab to the left, or the first tab
			const newIndex = Math.min(tabIndex, remainingTabs.length - 1);
			newActiveTabId = remainingTabs[Math.max(0, newIndex)]?.id;
		}

		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspace.id
					? { ...s, tabs: s.tabs.filter((t) => t.id !== tabId) }
					: s,
			),
			activeTabByWorkspace: {
				...state.activeTabByWorkspace,
				[workspace.id]: newActiveTabId,
			},
		}));
	},

	setActiveTab: (workspaceId, tabId) => {
		perfMark("abundio:switch-tab");
		set((state) => {
			const focusedPaneByTab = { ...state.focusedPaneByTab };
			// Save current focused pane for the old tab
			const oldTabId = state.activeTabByWorkspace[workspaceId];
			if (oldTabId && state.focusedPaneId) {
				focusedPaneByTab[oldTabId] = state.focusedPaneId;
			}
			// Restore focused pane for the new tab, falling back to first leaf in layout
			const restoredFocus = restoreTabFocus(
				state.workspaces,
				workspaceId,
				tabId,
				focusedPaneByTab,
			);
			return {
				activeTabByWorkspace: {
					...state.activeTabByWorkspace,
					[workspaceId]: tabId,
				},
				focusedPaneId: restoredFocus,
				focusedPaneByTab,
			};
		});
	},

	renameTab: async (tabId, name) => {
		await tabsApi.update(tabId, { name });
		set((state) => ({
			workspaces: state.workspaces.map((s) => ({
				...s,
				tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)),
			})),
		}));
	},

	// ── Pane/layout actions ──

	setFocusedPane: (paneId) => {
		if (get().focusedPaneId === paneId) return;
		set({ focusedPaneId: paneId });
	},

	// Persist an agent identity onto a terminal pane in its tab's layout.
	stampAgentOnPane: (paneId, agentId) => {
		const result = findMutatedTabLayout(get().workspaces, (layout) =>
			setAgentId(layout, paneId, agentId),
		);
		if (!result) return;
		set((s) => ({
			workspaces: updateTabInWorkspaces(
				s.workspaces,
				result.tabId,
				result.layoutJson,
			),
		}));
		tabsApi
			.update(result.tabId, { layoutJson: result.layoutJson })
			.catch(() => {});
	},

	stampAgentSessionOnPane: (paneId, agentId, sessionId) => {
		const result = findMutatedTabLayout(get().workspaces, (layout) =>
			setAgentSessionId(layout, paneId, agentId, sessionId),
		);
		if (!result) return;
		set((s) => ({
			workspaces: updateTabInWorkspaces(
				s.workspaces,
				result.tabId,
				result.layoutJson,
			),
		}));
		tabsApi
			.update(result.tabId, { layoutJson: result.layoutJson })
			.catch(() => {});
	},

	setAgentHandle: async (paneId, handle) => {
		// Stored trimmed, inner spaces collapsed ("  Agent  Two " → "Agent Two").
		if (handle !== null) handle = normalizeHandle(handle) ?? handle;
		const ws = get().findWorkspaceForPane(paneId);
		if (!ws) {
			return {
				ok: false,
				code: "invalid_handle",
				message: "That pane is not open.",
			};
		}
		if (handle !== null) {
			// Grammar and this Workspace first, without a round trip; then
			// Rust, which sees the whole Profile. A check that fails refuses
			// the name: letting it through could make a duplicate.
			const check = checkHandle(ws.tabs, paneId, handle);
			if (!check.ok) return check;
			const profileWide = await agentControlApi
				.handleCheck(ws.id, paneId, handle)
				.catch(
					() =>
						({
							ok: false,
							code: "invalid_handle",
							message: "Could not check the name. Try again.",
						}) as const,
				);
			if (!profileWide.ok) return profileWide;
		}
		const result = findMutatedTabLayout(
			[get().findWorkspaceForPane(paneId) ?? ws],
			(layout) => setAgentHandle(layout, paneId, handle ?? undefined),
		);
		if (result) {
			set((s) => ({
				workspaces: updateTabInWorkspaces(
					s.workspaces,
					result.tabId,
					result.layoutJson,
				),
			}));
			tabsApi
				.update(result.tabId, { layoutJson: result.layoutJson })
				.catch(() => {});
		}
		// Every Agent has a handle: clearing one hands out a default.
		if (handle === null) await get().ensureDefaultHandle(paneId);
		return { ok: true };
	},

	ensureDefaultHandle: async (paneId) => {
		const nodeNow = () => {
			const ws = get().findWorkspaceForPane(paneId);
			const tab = ws?.tabs.find((t) => {
				const l = parseTabLayout(t.layoutJson);
				return l ? containsPane(l, paneId) : false;
			});
			const layout = tab ? parseTabLayout(tab.layoutJson) : null;
			const node = layout ? findNode(layout, paneId) : null;
			return node?.type === "terminal" ? { ws, node } : null;
		};
		const before = nodeNow();
		if (!before?.ws || before.node.agentHandle) return;
		const ptyId = usePtyActivityStore.getState().panePtyMap[paneId];
		const inAgentMode =
			!!ptyId &&
			usePtyActivityStore.getState().activities[ptyId]?.detectionMode ===
				"agent";
		if (!before.node.agentId && !inAgentMode) return;
		const handle = await agentControlApi
			.handleDefault(before.ws.id, paneId)
			.catch(() => null);
		if (!handle) return;
		// Named meanwhile (by the user, or the Agent left): leave it.
		const after = nodeNow();
		if (!after?.ws || after.node.agentHandle) return;
		const result = findMutatedTabLayout([after.ws], (layout) =>
			setAgentHandle(layout, paneId, handle),
		);
		if (!result) return;
		set((s) => ({
			workspaces: updateTabInWorkspaces(
				s.workspaces,
				result.tabId,
				result.layoutJson,
			),
		}));
		tabsApi
			.update(result.tabId, { layoutJson: result.layoutJson })
			.catch(() => {});
	},

	stampCwdOnPane: (paneId, cwd) => {
		const result = findMutatedTabLayout(get().workspaces, (layout) =>
			setCwd(layout, paneId, cwd),
		);
		if (!result) return;
		set((s) => ({
			workspaces: updateTabInWorkspaces(
				s.workspaces,
				result.tabId,
				result.layoutJson,
			),
		}));
		tabsApi
			.update(result.tabId, { layoutJson: result.layoutJson })
			.catch(() => {});
	},

	// Full update: local state + persist to SQLite
	updateLayout: async (tabId, layout) => {
		const layoutJson = JSON.stringify(layout);
		await tabsApi.update(tabId, { layoutJson });
		set((state) => ({
			workspaces: updateTabInWorkspaces(state.workspaces, tabId, layoutJson),
		}));
	},

	// Local-only update (no IPC) — used during drag resize for smooth visuals
	updateLayoutLocal: (tabId, layout) => {
		const layoutJson = JSON.stringify(layout);
		set((state) => ({
			workspaces: updateTabInWorkspaces(state.workspaces, tabId, layoutJson),
		}));
	},

	// Persist current layout to SQLite — used on mouseup after drag
	persistLayout: async (tabId) => {
		const state = get();
		let tab: Tab | undefined;
		for (const s of state.workspaces) {
			tab = s.tabs.find((t) => t.id === tabId);
			if (tab) break;
		}
		if (!tab) return;
		await tabsApi.update(tabId, { layoutJson: tab.layoutJson });
	},

	setPtyStatus: (ptyId, status) =>
		set((state) => ({
			ptyStatuses: { ...state.ptyStatuses, [ptyId]: status },
		})),

	toggleSearch: (paneId) =>
		set((state) => {
			const target = paneId ?? state.focusedPaneId;
			return { searchPaneId: state.searchPaneId === target ? null : target };
		}),

	setWorkspaceBaseBranch: (workspaceId, baseBranch) =>
		set((state) => ({
			workspaces: state.workspaces.map((s) =>
				s.id === workspaceId ? { ...s, baseBranch } : s,
			),
		})),

	movePaneToTarget: async (sourceTabId, sourcePaneId, target) => {
		const state = get();
		const workspace = state.workspaces.find((ws) =>
			ws.tabs.some((t) => t.id === sourceTabId),
		);
		if (!workspace) return;

		const sourceTab = workspace.tabs.find((t) => t.id === sourceTabId);
		if (!sourceTab) return;

		const sourceLayout = parseTabLayout(sourceTab.layoutJson);
		if (!sourceLayout) return;

		const { remaining: sourceRemaining, removed: movedNode } = extractNode(
			sourceLayout,
			sourcePaneId,
		);
		if (!movedNode) return;

		if (target.kind === "pane-edge") {
			const { tabId: destTabId, paneId: targetPaneId, edge } = target;

			if (destTabId === sourceTabId) {
				// Same-tab move: insert beside in the post-extract remaining tree
				if (!sourceRemaining) return;
				const newLayout = insertBesideNode(
					sourceRemaining,
					targetPaneId,
					movedNode,
					edge,
				);
				await get().updateLayout(sourceTabId, newLayout);
				get().setFocusedPane(sourcePaneId);
			} else {
				// Cross-tab move
				const destTab = workspace.tabs.find((t) => t.id === destTabId);
				if (!destTab) return;
				const destLayout = parseTabLayout(destTab.layoutJson);
				if (!destLayout) return;
				const newDestLayout = insertBesideNode(
					destLayout,
					targetPaneId,
					movedNode,
					edge,
				);
				const destJson = JSON.stringify(newDestLayout);

				if (sourceRemaining) {
					const srcJson = JSON.stringify(sourceRemaining);
					await tabsApi.update(sourceTabId, { layoutJson: srcJson });
					await tabsApi.update(destTabId, { layoutJson: destJson });
					set((s) => ({
						workspaces: s.workspaces.map((ws) =>
							ws.id !== workspace.id
								? ws
								: {
										...ws,
										tabs: ws.tabs.map((t) => {
											if (t.id === sourceTabId)
												return { ...t, layoutJson: srcJson };
											if (t.id === destTabId)
												return { ...t, layoutJson: destJson };
											return t;
										}),
									},
						),
						activeTabByWorkspace: {
							...s.activeTabByWorkspace,
							[workspace.id]: destTabId,
						},
						focusedPaneId: sourcePaneId,
					}));
				} else {
					// Source tab becomes empty — do NOT call closeTab (it would
					// pty.deleteLog the moved pane). Do all DB writes first, then
					// a single atomic set so the pane is never in both layouts.
					await tabsApi.update(destTabId, { layoutJson: destJson });
					await tabsApi.delete(sourceTabId);

					set((s) => ({
						workspaces: s.workspaces.map((ws) =>
							ws.id !== workspace.id
								? ws
								: {
										...ws,
										tabs: ws.tabs
											.filter((t) => t.id !== sourceTabId)
											.map((t) =>
												t.id === destTabId ? { ...t, layoutJson: destJson } : t,
											),
									},
						),
						activeTabByWorkspace: {
							...s.activeTabByWorkspace,
							[workspace.id]: destTabId,
						},
						focusedPaneId: sourcePaneId,
					}));
				}
			}
		} else if (target.kind === "new-tab") {
			// Build the new tab name from the moved node type
			const tabName =
				movedNode.type === "file"
					? (movedNode.filePath.split("/").pop() ?? "file")
					: nextTabName(workspace.tabs.map((t) => t.name));

			// Do all DB writes BEFORE any state update so React never sees
			// the moved paneId in two layouts at the same time (which would
			// cause TerminalPool duplicate-key unmount + deferred destroy).
			const newTab = await tabsApi.create(workspace.id, tabName);
			const movedJson = JSON.stringify(movedNode);
			newTab.layoutJson = movedJson;
			await tabsApi.update(newTab.id, { layoutJson: movedJson });

			if (sourceRemaining) {
				const srcJson = JSON.stringify(sourceRemaining);
				await tabsApi.update(sourceTabId, { layoutJson: srcJson });

				// Single atomic set: source shrinks + new tab appears
				set((s) => ({
					workspaces: s.workspaces.map((ws) =>
						ws.id !== workspace.id
							? ws
							: {
									...ws,
									tabs: [
										...ws.tabs.map((t) =>
											t.id === sourceTabId ? { ...t, layoutJson: srcJson } : t,
										),
										newTab,
									],
								},
					),
					activeTabByWorkspace: {
						...s.activeTabByWorkspace,
						[workspace.id]: newTab.id,
					},
					focusedPaneId: sourcePaneId,
				}));
			} else {
				// Source tab had only the moved pane — delete it.
				// Do NOT call closeTab (which would pty.deleteLog the moved pane).
				await tabsApi.delete(sourceTabId);

				set((s) => ({
					workspaces: s.workspaces.map((ws) =>
						ws.id !== workspace.id
							? ws
							: {
									...ws,
									tabs: [
										...ws.tabs.filter((t) => t.id !== sourceTabId),
										newTab,
									],
								},
					),
					activeTabByWorkspace: {
						...s.activeTabByWorkspace,
						[workspace.id]: newTab.id,
					},
					focusedPaneId: sourcePaneId,
				}));
			}
		}
	},

	// ── Derived ──

	getActiveWorkspace: () => {
		const { workspaces, activeWorkspaceId } = get();
		return workspaces.find((s) => s.id === activeWorkspaceId);
	},

	findWorkspaceForPane: (paneId: string) => {
		// Searched across ALL workspaces' tabs, not just the active one:
		// TerminalPool mounts panes for every *opened* workspace, so a pane can
		// spawn, restart or write back its ptyId while its workspace is in the
		// background. `getActiveWorkspace()` is the wrong lens for anything
		// pane-scoped.
		for (const workspace of get().workspaces) {
			for (const tab of workspace.tabs) {
				const layout = parseTabLayout(tab.layoutJson);
				if (layout && containsPane(layout, paneId)) return workspace;
			}
		}
		return null;
	},

	getActiveTab: () => {
		const state = get();
		const workspace = state.workspaces.find(
			(s) => s.id === state.activeWorkspaceId,
		);
		if (!workspace) return undefined;
		const tabId = state.activeTabByWorkspace[workspace.id];
		return workspace.tabs.find((t) => t.id === tabId);
	},

	getActiveLayout: () => {
		const tab = get().getActiveTab();
		if (!tab) return null;
		return parseTabLayout(tab.layoutJson) ?? defaultLayout();
	},

	getTabsForWorkspace: (workspaceId) => {
		const workspace = get().workspaces.find((s) => s.id === workspaceId);
		return workspace?.tabs ?? [];
	},
}));
