import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodeBase64 } from "./base64";
import type {
	AgentHookEvent,
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
	PtyActivityType,
	PtyStatusType,
	PullRequest,
	SearchResult,
	Tab,
	TabUpdate,
	WorkspaceUpdate,
	WorkspaceWithTabs,
} from "./types";

export const pty = {
	spawn: (
		cwd: string,
		cols: number,
		rows: number,
		command?: string,
		shell?: string,
		logId?: string,
		ptyId?: string,
	) =>
		invoke<string>("pty_spawn", {
			cwd,
			cols,
			rows,
			command,
			shell,
			logId,
			ptyId,
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
	create: (name: string, rootFolder: string) =>
		invoke<WorkspaceWithTabs>("workspace_create", { name, rootFolder }),

	list: () => invoke<WorkspaceWithTabs[]>("workspace_list"),

	update: (id: string, updates: WorkspaceUpdate) =>
		invoke<void>("workspace_update", { id, updates }),

	delete: (id: string) => invoke<void>("workspace_delete", { id }),

	reorder: (ids: string[]) => invoke<void>("workspace_reorder", { ids }),
};

export const tabs = {
	create: (workspaceId: string, name: string) =>
		invoke<Tab>("tab_create", { workspaceId, name }),

	list: (workspaceId: string) => invoke<Tab[]>("tab_list", { workspaceId }),

	update: (id: string, updates: TabUpdate) =>
		invoke<void>("tab_update", { id, updates }),

	delete: (id: string) => invoke<void>("tab_delete", { id }),
};

export const git = {
	changedFiles: (cwd: string, baseBranch?: string | null) =>
		invoke<GitChangedFile[]>("git_changed_files", {
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

export const devEnvironments = {
	list: () => invoke<DetectedDevEnvironment[]>("list_dev_environments"),

	launch: (id: string, workspaceFolder: string, file: LaunchFile | null) =>
		invoke<void>("launch_dev_environment", {
			id,
			workspaceFolder,
			file,
		}),
};
