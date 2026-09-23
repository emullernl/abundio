// ── Pane layout tree (recursive) ──

export type PaneNode =
	| {
			type: "terminal";
			id: string;
			ptyId: string;
			agentId?: string;
			cwd?: string;
	  }
	| {
			type: "file";
			id: string;
			filePath: string;
			isDiff?: boolean;
			diffSource?: "git" | "file";
			diffSection?: GitChangedFile["section"];
			isDeleted?: boolean;
	  }
	| {
			// A live markdown preview bound to a file pane (its "source pane").
			// Owns no file of its own — mirrors the source pane's unsaved buffer.
			type: "preview";
			id: string;
			sourcePaneId: string;
	  }
	| {
			// One index stage of a conflicted file, shown beside its file pane (the
			// "source pane") in the Merge view. Read-only and owns no file — it
			// mirrors a stage, the way a preview pane mirrors a buffer. See
			// ADR-0030, which deliberately echoes ADR-0001's shape.
			type: "mergeSide";
			id: string;
			sourcePaneId: string;
			side: "current" | "incoming" | "base";
	  }
	| {
			type: "split";
			id: string;
			direction: "horizontal" | "vertical";
			ratio: number; // 0.0–1.0
			first: PaneNode;
			second: PaneNode;
	  };

// ── Profile ──

export interface Profile {
	id: string;
	name: string;
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface ProfileUpdate {
	name?: string;
}

/** Well-known id for the migration-created "Default" profile. */
export const DEFAULT_PROFILE_ID = "00000000-0000-0000-0000-000000000001";

// ── Workspace ──

export interface Workspace {
	id: string;
	name: string;
	rootFolder: string;
	agentPresetsJson: string;
	fileTabsJson: string;
	baseBranch: string | null;
	lastBranch: string | null;
	position: number;
	profileId: string;
	createdAt: number;
	updatedAt: number;
	/** Worktree setup commands run in a newly created worktree's terminal after
	 *  an in-app Add worktree. Only meaningful on a main-worktree Workspace. */
	worktreeSetupCommands: string;
}

export interface WorkspaceUpdate {
	name?: string;
	rootFolder?: string;
	agentPresetsJson?: string;
	fileTabsJson?: string;
	baseBranch?: string | null;
	lastBranch?: string;
	worktreeSetupCommands?: string;
}

export interface WorkspaceWithTabs {
	id: string;
	name: string;
	rootFolder: string;
	agentPresetsJson: string;
	fileTabsJson: string;
	baseBranch: string | null;
	lastBranch: string | null;
	position: number;
	profileId: string;
	createdAt: number;
	updatedAt: number;
	worktreeSetupCommands: string;
	tabs: Tab[];
}

// ── Worktrees ──

/** One worktree of a repository (mirrors the Rust `WorktreeEntry`). */
export interface WorktreeEntry {
	/** Canonicalized worktree root folder. */
	path: string;
	/** Checked-out branch shorthand, or null if detached/unborn/missing. */
	branch: string | null;
	/** True for the repository's main worktree (the Primary worktree). */
	isPrimary: boolean;
	/** Whether the folder still exists on disk. A git-tracked worktree with
	 *  `exists: false` is stale (keep + render stale), not a confirmed removal. */
	exists: boolean;
}

// ── Tab ──

export interface Tab {
	id: string;
	workspaceId: string;
	name: string;
	layoutJson: string;
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface TabUpdate {
	name?: string;
	layoutJson?: string;
	position?: number;
}

// ── File Explorer ──

export interface DirEntry {
	name: string;
	path: string;
	isDir: boolean;
	isSymlink: boolean;
	size: number;
	extension: string | null;
}

export interface FileContent {
	fileType: "text" | "image" | "binary";
	content: string | null;
	mime: string | null;
	size: number;
}

export interface FileEntry {
	name: string;
	path: string;
	relativePath: string;
}

// ── PTY ──

export type PtyStatusType =
	| { type: "running" }
	| { type: "exited"; code: number | null };

export type PtyActivityState =
	| "idle"
	| "active"
	| "ready"
	| "error"
	| "waiting";

export type PtyActivityType =
	| { type: "commandStarted" }
	| { type: "commandFinished" };

/** A lifecycle hook event emitted by an Agent, relayed in via the hook server. */
export interface AgentHookEvent {
	agent: string;
	event: string;
	payload: string;
}

/**
 * System-wide resource usage (whole machine, not Abundio-specific — see
 * ADR-0011). Pushed on the `app-metrics` event. `cpuPercent` is total CPU load
 * 0–100; the memory fields are used/total bytes (≈ Activity Monitor's "Memory
 * Used" on macOS).
 */
export interface AppMetrics {
	cpuPercent: number;
	memoryUsedBytes: number;
	memoryTotalBytes: number;
}

export type PtyDetectionMode = "agent" | "shell";

export interface CodingAgent {
	id: string;
	name: string;
	command: string;
	args?: string[];
	builtin: boolean;
	enabled: boolean;
}

// ── Git ──

export interface GitChangedFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	/** Which pair of git endpoints this row was produced by — except
	 *  "conflicted", which is a *state* rather than an endpoint pair and is the
	 *  deliberate exception in this union (see CONTEXT.md). */
	section: "conflicted" | "against_base" | "staged" | "unstaged" | "untracked";
}

export interface GitFileDiff {
	original: string;
	modified: string;
	filePath: string;
}

export interface BranchInfo {
	defaultBranch: string;
	currentBranch: string;
}

/** One row of the **Commits** section (see CONTEXT.md). */
export interface HistoryCommit {
	oid: string;
	subject: string;
	/** Full message, subject included — shown in the row's tooltip. */
	message: string;
	authorName: string;
	authorEmail: string;
	/** Author time, seconds since the Unix epoch. */
	time: number;
	isMerge: boolean;
	/** Below the divider: **Shared history** the base also has. False for an
	 *  **Ahead commit**, and for every row when the base is unknown. */
	shared: boolean;
	/** On the GitHub remote named by `CommitHistory.githubSlug`. Gates
	 *  "Open on GitHub". */
	onRemote: boolean;
}

/** The Workspace's recent history: every Ahead commit, then the Shared
 *  history, newest first, capped at 200 rows. */
export interface CommitHistory {
	/** The base the divider is named after; null when it cannot be resolved
	 *  (the list is then plain HEAD history). */
	base: string | null;
	/** The true Ahead count, even past the row cap. */
	ahead: number;
	commits: HistoryCommit[];
	/** `owner/repo` "Open on GitHub" links to — the same remote `onRemote` was
	 *  judged against. Null when the repository has no GitHub remote. */
	githubSlug: string | null;
}

/** A file one commit touched, against its first parent. */
export interface CommitFile {
	path: string;
	status: string;
	additions: number;
	deletions: number;
	/** Shown but not clickable: a text diff of it would be unreadable. */
	isBinary: boolean;
	/** A submodule pointer, not a file: nothing on either side to diff. */
	isSubmodule: boolean;
}

// ── GitHub CLI ──

export interface GhStatus {
	available: boolean;
	authenticated: boolean;
}

/** Payload of the broadcast `pr-state` event from the app-global PR poller.
 *  Carries both account-wide lists; All-vs-Repo filtering is client-side. */
export interface PrStatePayload {
	available: boolean;
	authenticated: boolean;
	reviewRequested: PullRequest[];
	mine: PullRequest[];
	error: string | null;
	/** Why the unread markers couldn't be fetched. The lists are still good. */
	unreadError: string | null;
}

/** One notification descriptor from the single-target `pr-changes` event. */
export interface PrChange {
	kind: string;
	body: string;
}

export interface PullRequest {
	number: number;
	title: string;
	url: string;
	author: string;
	createdAt: string;
	updatedAt: string;
	headRef: string;
	baseRef: string;
	additions: number;
	deletions: number;
	reviewDecision: string;
	statusCheckRollup: string;
	isDraft: boolean;
	labels: string[];
	repository: string;
	/** Id of the PR's GitHub notification thread when that thread is unread,
	 *  else null. GitHub owns the flag — see **Unread PR** in CONTEXT.md. */
	unreadThreadId: string | null;
}

export interface AvailableShell {
	name: string;
	path: string;
	available: boolean;
	isDefault: boolean;
}

export interface SearchMatch {
	lineNumber: number;
	lineContent: string;
	matchStart: number;
	matchEnd: number;
}

export interface SearchFileResult {
	filePath: string;
	matches: SearchMatch[];
}

export interface SearchResult {
	files: SearchFileResult[];
	totalMatches: number;
	truncated: boolean;
}

// ── Dev Environments ──

export interface DetectedDevEnvironment {
	id: string;
	displayName: string;
	iconName: string;
}

export interface LaunchFile {
	path: string;
	line?: number;
	column?: number;
}

// ── Prompt actions ──

/**
 * A **Prompt action** as it crosses the IPC boundary.
 *
 * `scopeKind` + `scopeAgentIds` are kept flat here because that is the shape of
 * the row; the frontend folds them into the `ActionScope` union in
 * `lib/promptActions.ts`. `paramsJson` stays a string on this side of the wire
 * for the same reason — Rust never parses it beyond checking it is an object.
 */
export interface PromptActionRow {
	id: string;
	name: string;
	body: string;
	scopeKind: "all" | "set";
	scopeAgentIds: string[];
	paramsJson: string;
	showInBar: boolean;
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface PromptActionCreate {
	name: string;
	body: string;
	scopeKind?: "all" | "set";
	scopeAgentIds?: string[];
	paramsJson?: string;
	showInBar?: boolean;
}

/** A partial update — omitted fields are left alone, so the in-pane popover can
 *  rename an action without round-tripping a row it never loaded. */
export interface PromptActionUpdate {
	name?: string;
	body?: string;
	scopeKind?: "all" | "set";
	scopeAgentIds?: string[];
	paramsJson?: string;
	showInBar?: boolean;
}
