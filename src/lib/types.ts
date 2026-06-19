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
			diffSection?: GitChangedFile["section"];
	  }
	| {
			// A live markdown preview bound to a file pane (its "source pane").
			// Owns no file of its own — mirrors the source pane's unsaved buffer.
			type: "preview";
			id: string;
			sourcePaneId: string;
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
	envJson: string;
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
	envJson?: string;
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
	envJson: string;
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
	section: "against_base" | "staged" | "unstaged";
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
