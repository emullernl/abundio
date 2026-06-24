import { invoke as realInvoke } from "@tauri-apps/api/core";
import { listen as realListen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodeBase64 } from "./base64";
import { isDemoMode } from "./demo";
import { mockInvoke } from "./demo/mockInvoke";
import { mockListen } from "./demo/mockListen";
import type {
	AgentHookEvent,
	AppMetrics,
	AvailableShell,
	BranchInfo,
	DetectedDevEnvironment,
	DirEntry,
	FileContent,
	FileEntry,
	GitChangedFile,
	GitFileDiff,
	LaunchFile,
	PrChange,
	Profile,
	ProfileUpdate,
	PrStatePayload,
	PtyActivityType,
	PtyStatusType,
	SearchFileResult,
	SearchResult,
	SecretMeta,
	Tab,
	TabUpdate,
	WorkspaceUpdate,
	WorkspaceWithTabs,
	WorktreeEntry,
} from "./types";

// Demo-mode chokepoint. In normal builds these are zero-overhead pass-throughs
// to Tauri; when `VITE_ABUNDIO_DEMO=true` they route every command/event to
// in-memory fixtures so the whole app renders fictional data. Every IPC call
// in this file funnels through these, so no call site below needs to change.
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	return isDemoMode() ? mockInvoke<T>(cmd, args) : realInvoke<T>(cmd, args);
}
function listen<T>(
	event: string,
	cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
	return isDemoMode()
		? mockListen<T>(event, cb)
		: (realListen<T>(event, cb) as Promise<UnlistenFn>);
}

export const pty = {
	spawn: (
		cwd: string,
		cols: number,
		rows: number,
		command?: string,
		shell?: string,
		logId?: string,
		ptyId?: string,
		workspaceName?: string,
		windowLabel?: string,
		workspaceId?: string,
	) =>
		invoke<string>("pty_spawn", {
			cwd,
			cols,
			rows,
			command,
			shell,
			logId,
			ptyId,
			workspaceName,
			windowLabel,
			workspaceId,
		}),

	write: (ptyId: string, data: string) =>
		invoke<void>("pty_write", { ptyId, data }),

	resize: (ptyId: string, cols: number, rows: number) =>
		invoke<void>("pty_resize", { ptyId, cols, rows }),

	kill: (ptyId: string) => invoke<void>("pty_kill", { ptyId }),

	onOutput: (
		ptyId: string,
		callback: (data: Uint8Array) => void,
	): Promise<UnlistenFn> =>
		listen<{ data: string }>(`pty-output-${ptyId}`, (event) => {
			callback(decodeBase64(event.payload.data));
		}),

	/** Like onOutput but passes the raw base64 string (no decode). */
	onOutputRaw: (
		ptyId: string,
		callback: (base64Data: string) => void,
	): Promise<UnlistenFn> =>
		listen<{ data: string }>(`pty-output-${ptyId}`, (event) => {
			callback(event.payload.data);
		}),

	onStatus: (
		ptyId: string,
		callback: (status: PtyStatusType) => void,
	): Promise<UnlistenFn> =>
		listen<PtyStatusType>(`pty-status-${ptyId}`, (event) =>
			callback(event.payload),
		),

	onActivity: (
		ptyId: string,
		callback: (activity: PtyActivityType) => void,
	): Promise<UnlistenFn> =>
		listen<PtyActivityType>(`pty-activity-${ptyId}`, (event) =>
			callback(event.payload),
		),

	/** Agent lifecycle hook events relayed in via the loopback hook server. */
	onHook: (
		ptyId: string,
		callback: (hookEvent: AgentHookEvent) => void,
	): Promise<UnlistenFn> =>
		listen<AgentHookEvent>(`agent-hook-${ptyId}`, (event) =>
			callback(event.payload),
		),

	readLog: async (logId: string): Promise<Uint8Array | null> => {
		const data = await invoke<string | null>("pty_read_log", { logId });
		if (!data) return null;
		return decodeBase64(data);
	},

	writeSnapshot: (paneId: string, data: string) =>
		invoke<void>("pty_write_snapshot", { paneId, data }),

	readSnapshot: (paneId: string) =>
		invoke<string | null>("pty_read_snapshot", { paneId }),

	deleteLog: (logId: string) => invoke<void>("pty_delete_log", { logId }),

	cleanupStaleLogs: (paneIds: string[]) =>
		invoke<void>("pty_cleanup_stale_logs", { paneIds }),
};

export const workspaces = {
	create: (name: string, rootFolder: string, profileId: string) =>
		invoke<WorkspaceWithTabs>("workspace_create", {
			name,
			rootFolder,
			profileId,
		}),

	list: (profileId: string) =>
		invoke<WorkspaceWithTabs[]>("workspace_list", { profileId }),

	update: (id: string, updates: WorkspaceUpdate) =>
		invoke<void>("workspace_update", { id, updates }),

	delete: (id: string) => invoke<void>("workspace_delete", { id }),

	reorder: (ids: string[]) => invoke<void>("workspace_reorder", { ids }),
};

export const secrets = {
	/** Lists vault secrets (metadata only — values never leave the keychain). */
	list: () => invoke<SecretMeta[]>("secret_list"),

	create: (name: string, value: string, description?: string) =>
		invoke<SecretMeta>("secret_create", { name, value, description }),

	/**
	 * Updates a secret. Omit `value` to keep the existing keychain value; pass
	 * a new string to overwrite it.
	 */
	update: (
		id: string,
		updates: { name?: string; description?: string; value?: string },
	) => invoke<SecretMeta>("secret_update", { id, ...updates }),

	delete: (id: string) => invoke<void>("secret_delete", { id }),

	/** Secrets assigned to a workspace. */
	listForWorkspace: (workspaceId: string) =>
		invoke<SecretMeta[]>("workspace_secret_list", { workspaceId }),

	/** Replaces a workspace's full set of assigned secret ids. */
	setForWorkspace: (workspaceId: string, secretIds: string[]) =>
		invoke<void>("workspace_secret_set", { workspaceId, secretIds }),
};

export const notes = {
	/** Fetch a workspace's note (TipTap JSON string). `""` means no note yet. */
	get: (workspaceId: string) => invoke<string>("note_get", { workspaceId }),

	/** Upsert a workspace's note. `content` is an opaque TipTap JSON string. */
	set: (workspaceId: string, content: string) =>
		invoke<void>("note_set", { workspaceId, content }),
};

export const profiles = {
	list: () => invoke<Profile[]>("profile_list"),

	create: (name: string) => invoke<Profile>("profile_create", { name }),

	update: (id: string, updates: ProfileUpdate) =>
		invoke<void>("profile_update", { id, updates }),

	delete: (id: string) => invoke<void>("profile_delete", { id }),

	reorder: (ids: string[]) => invoke<void>("profile_reorder", { ids }),

	/** Notify the Rust side of the active profile id for the calling window
	 *  (Tauri injects the window automatically). The Rust side updates its
	 *  per-window ownership map, rebuilds the native menu, and emits
	 *  `profile-ownership-changed` to all windows. */
	setActiveProfileId: (profileId: string | null) =>
		invoke<void>("set_active_profile_id", { profileId }),

	/** Returns the profile id this window was spawned with, or null if the
	 *  Rust map has no entry for this window. */
	getActiveProfileForWindow: () =>
		invoke<string | null>("get_active_profile_for_window"),

	/** Returns a profileId → windowLabel map. Used by Settings to compute
	 *  "open in another window" disabled states. */
	getOwnershipMap: () =>
		invoke<Record<string, string>>("get_profile_ownership_map"),

	/** Opens a new application Window with the given profile. Rejects if the
	 *  profile is already open in another window. */
	openWindowWithProfile: (profileId: string) =>
		invoke<string>("open_window_with_profile", { profileId }),

	/** Creates a fresh "Untitled" profile (auto-numbered on collision) and
	 *  opens it in a new application Window. */
	createUntitledProfileInNewWindow: () =>
		invoke<string>("create_untitled_profile_in_new_window"),
};

/** Per-Window session reporting — pushes state the Rust side needs to aggregate
 *  across Windows. See ADR-0016. */
export const windowSession = {
	/** Report this Window's current count of Opened workspaces. The Rust side
	 *  mirrors it into a per-window map and sums across all Windows at quit time
	 *  to decide whether to show the quit confirmation. */
	reportOpenedWorkspaceCount: (count: number) =>
		invoke<void>("report_opened_workspace_count", { count }),
};

export const tabs = {
	create: (workspaceId: string, name: string) =>
		invoke<Tab>("tab_create", { workspaceId, name }),

	list: (workspaceId: string) => invoke<Tab[]>("tab_list", { workspaceId }),

	update: (id: string, updates: TabUpdate) =>
		invoke<void>("tab_update", { id, updates }),

	delete: (id: string) => invoke<void>("tab_delete", { id }),
};

export interface GitFetchBundle {
	changedFiles: GitChangedFile[];
	branchInfo: BranchInfo;
	statusFingerprint: string;
}

/** Discriminated union pushed by the Rust `GitScheduler` on every refresh.
 *  Single channel for success and failure — keeps state-update ordering
 *  trivial on the frontend (one listener, one switch). */
export type GitStateEvent =
	| { kind: "bundle"; bundle: GitFetchBundle }
	| { kind: "error"; message: string; notGitRepo: boolean };

export const git = {
	changedFiles: (cwd: string, baseBranch?: string | null) =>
		invoke<GitChangedFile[]>("git_changed_files", {
			cwd,
			baseBranch: baseBranch ?? null,
		}),

	/** Single-IPC bundle replacing the 3 separate calls (changedFiles +
	 *  branchInfo + statusFingerprint). Internally runs them in parallel
	 *  via scoped threads — see `git_fetch_bundle` in src-tauri. The
	 *  single round-trip is the dominant cost savings on macOS/WKWebView
	 *  where each `invoke` has significant per-call main-thread overhead. */
	fetchBundle: (cwd: string, baseBranch?: string | null) =>
		invoke<GitFetchBundle>("git_fetch_bundle", {
			cwd,
			baseBranch: baseBranch ?? null,
		}),

	fileDiff: (
		cwd: string,
		filePath: string,
		section: string,
		baseBranch?: string | null,
	) =>
		invoke<GitFileDiff>("git_file_diff", {
			cwd,
			filePath,
			section,
			baseBranch: baseBranch ?? null,
		}),

	branchInfo: (cwd: string) => invoke<BranchInfo>("git_branch_info", { cwd }),

	listBranches: (cwd: string) => invoke<string[]>("git_list_branches", { cwd }),

	statusFingerprint: (cwd: string) =>
		invoke<string>("git_status_fingerprint", { cwd }),

	workspacesSummary: (
		requests: { workspaceId: string; cwd: string; baseBranch: string | null }[],
	) => invoke<WorkspaceGitSummary[]>("git_workspaces_summary", { requests }),

	/** Start the per-workspace Rust GitScheduler. Fires an immediate refresh
	 *  on start, then pushes a `git-state-<workspaceId>` event on every
	 *  meaningful change. Idempotent — calling twice with the same id is a no-op.
	 *  To change `baseBranch`, call `schedulerStop` then `schedulerStart` again. */
	schedulerStart: (
		workspaceId: string,
		rootPath: string,
		baseBranch?: string | null,
	) =>
		invoke<void>("git_scheduler_start", {
			workspaceId,
			rootPath,
			baseBranch: baseBranch ?? null,
		}),

	schedulerStop: (workspaceId: string) =>
		invoke<void>("git_scheduler_stop", { workspaceId }),

	/** Subscribe to the per-workspace state stream pushed by the Rust scheduler.
	 *  Replaces the JS-driven `fetchChanges`-on-every-event loop that caused
	 *  the WKWebView `invoke()` freeze on `git stash`. */
	onGitState: (
		workspaceId: string,
		callback: (event: GitStateEvent) => void,
	): Promise<UnlistenFn> =>
		listen<GitStateEvent>(`git-state-${workspaceId}`, (event) => {
			callback(event.payload);
		}),

	/** GitHub `owner/repo` for a workspace folder, or null. Drives the
	 *  client-side All-vs-Repo PR filter (ADR-0019). */
	repoSlug: (cwd: string) => invoke<string | null>("git_repo_slug", { cwd }),
};

export type WorkspaceGitSummary = {
	workspaceId: string;
	isGitRepo: boolean;
	currentBranch: string | null;
	changedFileCount: number;
	additions: number;
	deletions: number;
	/** Stable per-repository key shared by all worktrees of one repo. Null when
	 *  not a git repo. Drives the sidebar Worktree set grouping. */
	worktreeGroupKey: string | null;
	/** True when this workspace's folder is the repository's main worktree. */
	isMainWorktree: boolean;
	/** Canonicalized worktree root — compared against canonical
	 *  `list_repo_worktrees` paths so symlinked folders don't mis-reconcile. */
	worktreeRoot: string | null;
};

// ── Agent telemetry ──
//
// One AgentTurnRecord per Turn (a single prompt → turn-finished cycle). The
// frontend Turn tracker (agentTurnTracker.ts) records rows; the Statistics
// overlay queries Profile-scoped rollups. See ADR-0018 and
// docs/plans/agent-turn-telemetry-and-statistics-overlay.md.
//
// Timestamps are Unix ms (except `createdAt`, Unix seconds). Line counts are
// `null` when unattributed (e.g. two Turns overlapped in one Workspace).

export interface AgentTurnRecord {
	id: string;
	sessionId: string | null;
	profileId: string;
	workspaceId: string | null;
	workspacePath: string;
	workspaceName: string;
	agentId: string;
	ptyId: string;
	startedAt: number;
	endedAt: number | null;
	durationMs: number | null;
	workingMs: number | null;
	waitingMs: number | null;
	endReason: string | null;
	permissionRequestsCount: number;
	errorCount: number;
	linesAdded: number | null;
	linesDeleted: number | null;
	filesChanged: number | null;
	gitAddedStart: number | null;
	gitDeletedStart: number | null;
	gitAddedEnd: number | null;
	gitDeletedEnd: number | null;
	createdAt: number;
}

export interface AgentTurnBucket {
	bucket: string;
	agentId: string | null;
	workspaceId: string | null;
	workspaceName: string | null;
	turnCount: number;
	/** Turns whose line counts are attributed (non-null). */
	attributedTurnCount: number;
	totalDurationMs: number;
	totalWorkingMs: number;
	totalWaitingMs: number;
	totalLinesAdded: number;
	totalLinesDeleted: number;
	totalFilesChanged: number;
	totalPermissionRequests: number;
	totalErrors: number;
}

export interface AgentTurnTotals {
	turnCount: number;
	attributedTurnCount: number;
	sessionCount: number;
	totalDurationMs: number;
	totalWorkingMs: number;
	totalWaitingMs: number;
	totalLinesAdded: number;
	totalLinesDeleted: number;
	totalFilesChanged: number;
	totalPermissionRequests: number;
	totalErrors: number;
	longestTurnMs: number;
}

export type TelemetryBucket = "day" | "month" | "year";
export type TelemetryGroupBy = "none" | "agent" | "workspace";

export const telemetry = {
	/** Persist a finalized Turn (idempotent by id). */
	recordTurn: (turn: AgentTurnRecord) =>
		invoke<void>("telemetry_record_turn", { turn }),

	/** Bucketed rollups for one Profile in the `[fromMs, toMs)` window. */
	buckets: (
		profileId: string,
		fromMs: number,
		toMs: number,
		bucket: TelemetryBucket,
		groupBy: TelemetryGroupBy,
	) =>
		invoke<AgentTurnBucket[]>("telemetry_buckets", {
			profileId,
			fromMs,
			toMs,
			bucket,
			groupBy,
		}),

	/** Overall totals for one Profile in the window. */
	totals: (profileId: string, fromMs: number, toMs: number) =>
		invoke<AgentTurnTotals>("telemetry_totals", { profileId, fromMs, toMs }),

	/** Raw Turn rows (drill-down table), newest first. */
	listTurns: (profileId: string, fromMs: number, toMs: number) =>
		invoke<AgentTurnRecord[]>("telemetry_list_turns", {
			profileId,
			fromMs,
			toMs,
		}),
};

export const worktrees = {
	/** Every worktree of the repository `cwd` belongs to (primary first). */
	list: (cwd: string) =>
		invoke<WorktreeEntry[]>("list_repo_worktrees", { cwd }),

	/** Create a worktree of the primary's repo, checking out `branch` (created
	 *  from the primary's HEAD if it doesn't exist) at absolute `path`. */
	add: (primaryCwd: string, branch: string, path: string) =>
		invoke<WorktreeEntry>("worktree_add", { primaryCwd, branch, path }),

	/** Remove the worktree whose folder is `worktreePath` (deletes the folder,
	 *  prunes git's admin link, keeps the branch). */
	remove: (primaryCwd: string, worktreePath: string) =>
		invoke<void>("worktree_remove", { primaryCwd, worktreePath }),

	/** True if the worktree at `cwd` has uncommitted/untracked changes. */
	dirty: (cwd: string) => invoke<boolean>("worktree_dirty", { cwd }),

	/** Set this Window's desired set of watched repository common dirs. The
	 *  Rust watcher emits `worktrees-changed` when a CLI add/remove touches one. */
	watchSet: (commonDirs: string[]) =>
		invoke<void>("worktree_watch_set", { commonDirs }),

	/** Fires when a watched repo's worktree set changes on disk. */
	onChanged: (callback: (commonDir: string) => void): Promise<UnlistenFn> =>
		listen<{ commonDir: string }>("worktrees-changed", (event) =>
			callback(event.payload.commonDir),
		),
};

// GitHub PR data is fetched by the app-global Rust poller (ADR-0019). The
// frontend only hydrates from the cached snapshot, listens for pushes, and
// forwards the user's manual Refresh / settings changes.
export const pr = {
	/** Last poll result cached in Rust, for new Windows to paint instantly
	 *  without triggering a gh call. Null until the first poll completes. */
	snapshot: () => invoke<PrStatePayload | null>("pr_poller_snapshot"),

	/** Force an immediate one-shot poll (manual Refresh). Bypasses the enabled
	 *  flag and the min-gap, and re-checks gh auth. */
	refresh: () => invoke<void>("pr_poller_refresh"),

	/** Push the persisted polling config: enabled + focused interval (minutes). */
	setConfig: (enabled: boolean, minutes: number) =>
		invoke<void>("pr_poller_set_config", { enabled, minutes }),

	/** Broadcast PR lists pushed by the poller — every Window receives these. */
	onPrState: (
		callback: (payload: PrStatePayload) => void,
	): Promise<UnlistenFn> =>
		listen<PrStatePayload>("pr-state", (event) => callback(event.payload)),

	/** Notification descriptors — emitted to ONE Window so N Windows don't
	 *  each fire duplicate OS notifications. */
	onPrChanges: (callback: (changes: PrChange[]) => void): Promise<UnlistenFn> =>
		listen<PrChange[]>("pr-changes", (event) => callback(event.payload)),
};

export const fs = {
	listDir: (path: string) => invoke<DirEntry[]>("fs_list_dir", { path }),

	listFiles: (rootPath: string, maxFiles?: number) =>
		invoke<FileEntry[]>("fs_list_files", { rootPath, maxFiles }),

	indexWorkspaceFiles: (rootPath: string) =>
		invoke<string[]>("fs_index_workspace_files", { rootPath }),

	readFile: (path: string) => invoke<FileContent>("fs_read_file", { path }),

	writeFile: (path: string, content: string) =>
		invoke<void>("fs_write_file", { path, content }),

	fileExists: (path: string) => invoke<boolean>("fs_file_exists", { path }),

	watchStart: (rootPath: string) =>
		invoke<void>("fs_watch_start", { rootPath }),

	watchStop: (rootPath: string) => invoke<void>("fs_watch_stop", { rootPath }),

	onFsChange: (
		rootPath: string,
		callback: (change: {
			paths: string[];
			changedFiles: string[];
			removedFiles: string[];
		}) => void,
	): Promise<UnlistenFn> =>
		listen<{
			root: string;
			paths: string[];
			changedFiles: string[];
			removedFiles: string[];
		}>("fs-change", (event) => {
			if (event.payload.root === rootPath) {
				callback({
					paths: event.payload.paths,
					changedFiles: event.payload.changedFiles,
					removedFiles: event.payload.removedFiles,
				});
			}
		}),

	onGitChange: (rootPath: string, callback: () => void): Promise<UnlistenFn> =>
		listen<{ root: string }>("git-change", (event) => {
			if (event.payload.root === rootPath) {
				callback();
			}
		}),

	search: (params: {
		rootPath: string;
		query: string;
		caseSensitive: boolean;
		isRegex: boolean;
		wholeWord: boolean;
		includePattern: string | null;
		excludePattern: string | null;
		maxResults?: number;
		searchId: string;
	}) => invoke<SearchResult>("fs_search", { params }),

	/** Subscribe to files streamed by an in-flight `fs_search`, as they're found. */
	onSearchProgress: (
		searchId: string,
		callback: (file: SearchFileResult) => void,
	): Promise<UnlistenFn> =>
		listen<SearchFileResult>(`search-progress-${searchId}`, (event) =>
			callback(event.payload),
		),

	searchCancel: (searchId: string) =>
		invoke<void>("fs_search_cancel", { searchId }),

	createFile: (path: string) => invoke<void>("fs_create_file", { path }),

	createFolder: (path: string) => invoke<void>("fs_create_folder", { path }),

	rename: (from: string, to: string) => invoke<void>("fs_rename", { from, to }),

	deletePath: (path: string) => invoke<void>("fs_delete", { path }),

	revealInFolder: (path: string) =>
		invoke<void>("fs_reveal_in_folder", { path }),
};

export const fonts = {
	listSystemFonts: () => invoke<string[]>("list_system_fonts"),
};

export const shells = {
	listAvailable: () => invoke<AvailableShell[]>("list_available_shells"),

	/** The shell a new PTY spawns with when no `shellPath` is set. Resolved in
	 *  Rust (Git Bash preferred on Windows). Used by file-drop to choose the
	 *  right path style for the "System Default" shell. */
	default: () => invoke<string>("default_shell"),
};

export const agentRegistry = {
	listInstalled: (commands: string[]) =>
		invoke<string[]>("list_installed_agent_commands", { commands }),
};

/** On-disk registration state of one Agent's hooks (mirrors Rust `HookConfigState`). */
export type HookConfigState = "registered" | "notRegistered" | "configError";

/** Read-only per-Agent provisioning footprint (mirrors Rust `AgentHookStatus`). */
export interface AgentHookStatus {
	agentId: string;
	configPath: string;
	ownership: "merged" | "owned";
	events: string[];
	state: HookConfigState;
}

export const agentHooks = {
	/**
	 * Enable/disable Agent status hooks by (un)provisioning agent configs.
	 * `enabledAgents` are the agent ids whose per-agent toggle is on — only those
	 * get hooks; the rest are stripped. When `enabled` is false, all are stripped.
	 */
	provision: (enabled: boolean, enabledAgents: string[]) =>
		invoke<void>("agent_hooks_provision", { enabled, enabledAgents }),
	/**
	 * Provision hooks at startup. Every Window's settings rehydrate calls this;
	 * Rust runs it once per process (guard), so N Windows don't each rewrite the
	 * same global configs. See ADR-0003 (Revisited).
	 */
	provisionStartup: (enabled: boolean, enabledAgents: string[]) =>
		invoke<void>("agent_hooks_provision_startup", { enabled, enabledAgents }),
	/**
	 * Register hooks for one Agent on demand if missing (creating its config dir
	 * if needed). Called when an Agent is launched. Returns whether it
	 * provisioned. No-op when `enabled` is false or the Agent is unsupported.
	 */
	ensure: (agentId: string, enabled: boolean) =>
		invoke<boolean>("ensure_agent_hooks", { agentId, enabled }),
	/** Per-Agent provisioning footprint for the Settings UI. */
	status: () => invoke<AgentHookStatus[]>("agent_hook_status"),
};

export const metrics = {
	/**
	 * Subscribe to system-wide CPU + memory load, pushed from Rust
	 * (`app_metrics.rs`) roughly every 1.5s. One global event for all windows.
	 */
	onAppMetrics: (
		callback: (metrics: AppMetrics) => void,
	): Promise<UnlistenFn> =>
		listen<AppMetrics>("app-metrics", (event) => callback(event.payload)),
};

/** Metadata for an available app update. Mirrors the Rust `UpdateInfo`. */
export interface UpdateInfo {
	version: string;
	currentVersion: string;
	body: string | null;
	date: string | null;
}

/** Download progress for a staging update. `total` is null until known. */
export interface UpdateDownloadProgress {
	downloaded: number;
	total: number | null;
}

export const updates = {
	/** Manually check for an update. Resolves to null when up to date.
	 *  Stashes any found update Rust-side for a subsequent `download()`. */
	check: () => invoke<UpdateInfo | null>("updater_check"),

	/** Download the pending update and stage it for install (on quit, or via
	 *  `installNow`). Emits progress via `onDownloadProgress`. */
	download: () => invoke<void>("updater_download"),

	/** Install the staged update immediately and restart the app. The caller
	 *  must confirm first — this terminates all Windows, PTYs and Agents. */
	installNow: () => invoke<void>("updater_install_now"),

	/** Enable/disable background auto-checks (the app-wide Rust flag). */
	setAutoCheck: (enabled: boolean) =>
		invoke<void>("updater_set_auto_check", { enabled }),

	/** Fires (focused Window only) when the Rust background loop finds an update. */
	onUpdateAvailable: (
		callback: (info: UpdateInfo) => void,
	): Promise<UnlistenFn> =>
		listen<UpdateInfo>("update-available", (event) => callback(event.payload)),

	/** Streams download progress while `download()` runs. */
	onDownloadProgress: (
		callback: (progress: UpdateDownloadProgress) => void,
	): Promise<UnlistenFn> =>
		listen<UpdateDownloadProgress>("update-download-progress", (event) =>
			callback(event.payload),
		),
};

export const clipboardImage = {
	/** Decode an image file and place it on the OS clipboard as PNG, so a running
	 *  agent ingests it via its Ctrl+V clipboard-image path. Backs the "Smart
	 *  image drop" behaviour — see useTerminalFileDrop. Rejects on an unreadable
	 *  or unsupported image (caller falls back to inserting the path). */
	setFromPath: (path: string) =>
		invoke<void>("set_clipboard_image_from_path", { path }),
};

export const devEnvironments = {
	list: () => invoke<DetectedDevEnvironment[]>("list_dev_environments"),

	launch: (id: string, workspaceFolder: string, file: LaunchFile | null) =>
		invoke<void>("launch_dev_environment", {
			id,
			workspaceFolder,
			file,
		}),
};
