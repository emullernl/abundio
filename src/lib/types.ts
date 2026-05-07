// ── Pane layout tree (recursive) ──

export type PaneNode =
	| { type: "terminal"; id: string; ptyId: string; agentId?: string; cwd?: string }
	| {
			type: "file";
			id: string;
			filePath: string;
			isDiff?: boolean;
			diffSection?: GitChangedFile["section"];
	  }
	| {
			type: "split";
			id: string;
			direction: "horizontal" | "vertical";
			ratio: number; // 0.0–1.0
			first: PaneNode;
			second: PaneNode;
	  };

// ── Workspace ──

export interface Workspace {
	id: string;
	name: string;
	rootFolder: string;
	envJson: string;
	agentPresetsJson: string;
	fileTabsJson: string;
	baseBranch: string | null;
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface WorkspaceUpdate {
	name?: string;
	rootFolder?: string;
	envJson?: string;
	agentPresetsJson?: string;
	fileTabsJson?: string;
	baseBranch?: string | null;
}

export interface WorkspaceWithTabs {
	id: string;
	name: string;
	rootFolder: string;
	envJson: string;
	agentPresetsJson: string;
	fileTabsJson: string;
	baseBranch: string | null;
	position: number;
	createdAt: number;
	updatedAt: number;
	tabs: Tab[];
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

export type PtyActivityState = "idle" | "active" | "ready" | "error";

export type PtyActivityType =
	| { type: "commandStarted" }
	| { type: "commandFinished" };

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
	hasRemote: boolean;
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
