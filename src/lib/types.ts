// ── Pane layout tree (recursive) ──

export type PaneNode =
	| { type: "terminal"; id: string; ptyId: string }
	| {
			type: "split";
			id: string;
			direction: "horizontal" | "vertical";
			ratio: number; // 0.0–1.0
			first: PaneNode;
			second: PaneNode;
	  };

// ── Session ──

export interface Session {
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

export interface SessionUpdate {
	name?: string;
	rootFolder?: string;
	envJson?: string;
	agentPresetsJson?: string;
	fileTabsJson?: string;
	baseBranch?: string | null;
}

export interface SessionWithTabs {
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
	sessionId: string;
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

// ── PTY ──

export type PtyStatusType = { type: "running" } | { type: "exited"; code: number | null };

export type PtyActivityState = "idle" | "active" | "waiting" | "error";

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
	comments: number;
	repository: string;
}
