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
	GhStatus,
	GitChangedFile,
	GitFileDiff,
	LaunchFile,
	Profile,
	ProfileUpdate,
	PtyActivityType,
	PtyStatusType,
	PullRequest,
	SearchFileResult,
	SearchResult,
	Tab,
	TabUpdate,
	WorkspaceUpdate,
	WorkspaceWithTabs,
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
};

export type WorkspaceGitSummary = {
	workspaceId: string;
	isGitRepo: boolean;
	currentBranch: string | null;
	changedFileCount: number;
	additions: number;
	deletions: number;
};

export const gh = {
	status: (cwd: string) => invoke<GhStatus>("gh_status", { cwd }),

	reviewRequests: (cwd: string) =>
		invoke<PullRequest[]>("gh_review_requests", { cwd }),

	reviewRequestsAll: (cwd: string) =>
		invoke<PullRequest[]>("gh_review_requests_all", { cwd }),

	myPrs: (cwd: string) => invoke<PullRequest[]>("gh_my_prs", { cwd }),

	myPrsAll: (cwd: string) => invoke<PullRequest[]>("gh_my_prs_all", { cwd }),
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
};

export const agentRegistry = {
	listInstalled: (commands: string[]) =>
		invoke<string[]>("list_installed_agent_commands", { commands }),
};

export const agentHooks = {
	/** Enable/disable Agent status hooks by (un)provisioning agent configs. */
	provision: (enabled: boolean) =>
		invoke<void>("agent_hooks_provision", { enabled }),
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

export const devEnvironments = {
	list: () => invoke<DetectedDevEnvironment[]>("list_dev_environments"),

	launch: (id: string, workspaceFolder: string, file: LaunchFile | null) =>
		invoke<void>("launch_dev_environment", {
			id,
			workspaceFolder,
			file,
		}),
};
