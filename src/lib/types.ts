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
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface SessionUpdate {
	name?: string;
	rootFolder?: string;
	envJson?: string;
	agentPresetsJson?: string;
}

export interface SessionWithTabs {
	id: string;
	name: string;
	rootFolder: string;
	envJson: string;
	agentPresetsJson: string;
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

// ── Agent ──

export interface AgentPreset {
	agentName: string;
	args: string[];
	env: Record<string, string>;
	autoSpawn: boolean;
}

export interface AgentInfo {
	name: string;
	binary: string;
	displayName: string;
	icon: string;
	defaultArgs: string[];
	available: boolean;
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
