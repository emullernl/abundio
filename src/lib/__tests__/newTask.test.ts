import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import { BUILTIN_AGENTS } from "../agents";
import {
	type AgentPane,
	defaultRestartPane,
	defaultTaskAgentId,
	defaultWorktreeFolder,
	initialDestination,
	type LiveAgentState,
	shellSupportsTasks,
	stepIssueIndex,
	taskAgents,
	taskSetupFailed,
	visibleIssue,
	workspaceAgentPanes,
} from "../newTask";
import type { PaneNode, Tab, WorkspaceWithTabs } from "../types";

function tab(id: string, layout: PaneNode): Tab {
	return {
		id,
		workspaceId: "ws",
		name: `Tab ${id}`,
		layoutJson: JSON.stringify(layout),
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function ws(tabs: Tab[]): WorkspaceWithTabs {
	return {
		id: "ws",
		name: "Repo",
		rootFolder: "/repo",
		agentPresetsJson: "{}",
		fileTabsJson: "{}",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs,
	};
}

function entry(state: PtyActivityEntry["state"]): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode: "agent",
		hookDriven: true,
		shellCommandRunning: false,
	};
}

const layout: PaneNode = {
	type: "split",
	id: "s",
	direction: "horizontal",
	ratio: 0.5,
	first: { type: "terminal", id: "a", ptyId: "pa", agentId: "claude" },
	second: { type: "terminal", id: "b", ptyId: "pb" },
};

const live: LiveAgentState = {
	panePtyMap: { a: "pa", b: "pb", c: "pc" },
	agentPtyIds: new Set(["pa", "pc"]),
	detectedAgentIds: { pc: "codex" },
	activities: { pa: entry("active"), pc: entry("idle") },
};

describe("workspaceAgentPanes", () => {
	it("lists only agent-mode panes, with detected or stamped agent", () => {
		const panes = workspaceAgentPanes(
			ws([
				tab("t1", layout),
				tab("t2", { type: "terminal", id: "c", ptyId: "pc" }),
			]),
			live,
		);
		expect(panes).toEqual([
			{
				paneId: "a",
				tabId: "t1",
				tabName: "Tab t1",
				agentId: "claude",
				busy: "working",
			},
			{
				paneId: "c",
				tabId: "t2",
				tabName: "Tab t2",
				agentId: "codex",
				busy: null,
			},
		]);
	});
});

describe("defaultRestartPane", () => {
	const a: AgentPane = {
		paneId: "a",
		tabId: "t",
		tabName: "",
		agentId: "claude",
		busy: null,
	};
	const c: AgentPane = { ...a, paneId: "c" };

	it("prefers the focused pane", () => {
		expect(defaultRestartPane([a, c], "c")).toBe(c);
	});
	it("takes the only agent pane when focus is elsewhere", () => {
		expect(defaultRestartPane([a], "zzz")).toBe(a);
	});
	it("asks (null) when several and none focused, or none at all", () => {
		expect(defaultRestartPane([a, c], null)).toBeNull();
		expect(defaultRestartPane([], "a")).toBeNull();
	});
});

describe("agent defaults", () => {
	const offered = taskAgents(BUILTIN_AGENTS);

	it("offers only watched, task-capable agents", () => {
		expect(offered.map((a) => a.id)).not.toContain("kimi");
		expect(offered.map((a) => a.id)).not.toContain("aider");
		expect(
			taskAgents(
				BUILTIN_AGENTS.map((a) => ({ ...a, enabled: a.id !== "claude" })),
			).map((a) => a.id),
		).not.toContain("claude");
	});

	it("picks the first preferred agent that can take a task", () => {
		expect(defaultTaskAgentId(offered, ["kimi", "codex", "claude"])).toBe(
			"codex",
		);
		expect(defaultTaskAgentId(offered, [undefined])).toBe(offered[0].id);
		expect(defaultTaskAgentId([], ["claude"])).toBeUndefined();
	});
});

describe("initialDestination", () => {
	it("shows the remembered choice", () => {
		expect(initialDestination("restart", true, true)).toBe("restart");
		expect(initialDestination("newTab", false, false)).toBe("newTab");
		expect(initialDestination("worktree", false, true)).toBe("worktree");
	});
	it("falls back to New tab when there is nothing to restart", () => {
		expect(initialDestination("restart", false, true)).toBe("newTab");
	});
	it("falls back to New tab when there is no git repository", () => {
		expect(initialDestination("worktree", true, false)).toBe("newTab");
	});
});

describe("taskSetupFailed", () => {
	const start = { type: "command_start" };
	const end = { type: "command_end" };
	const cwd = { type: "cwd_change" };
	it("is a command_end before any command_start while awaiting the Task", () => {
		expect(taskSetupFailed(true, [cwd, end])).toBe(true);
		expect(taskSetupFailed(true, [end, start])).toBe(true);
	});
	it("is not the Agent's own exit", () => {
		expect(taskSetupFailed(true, [start, end])).toBe(false);
		expect(taskSetupFailed(false, [end])).toBe(false);
		expect(taskSetupFailed(true, [cwd])).toBe(false);
	});
});

describe("defaultWorktreeFolder", () => {
	it("mirrors Add worktree's derivation", () => {
		expect(defaultWorktreeFolder("app", "feat/x")).toBe(
			"../app.worktrees/feat-x",
		);
		expect(defaultWorktreeFolder("app", "")).toBe("");
	});
});

describe("shellSupportsTasks", () => {
	it("accepts zsh and bash, including Git Bash, and nothing else", () => {
		expect(shellSupportsTasks("/bin/zsh")).toBe(true);
		expect(shellSupportsTasks("/opt/homebrew/bin/bash")).toBe(true);
		expect(shellSupportsTasks("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(
			true,
		);
		expect(shellSupportsTasks("/usr/local/bin/fish")).toBe(false);
		expect(shellSupportsTasks("C:\\Windows\\System32\\cmd.exe")).toBe(false);
		expect(shellSupportsTasks("pwsh")).toBe(false);
	});
});

describe("issue picking", () => {
	const a = { number: 214 };
	const b = { number: 209 };

	// Select #214, then filter to "209": Start must not launch the hidden #214.
	it("drops a pick the search no longer shows", () => {
		expect(visibleIssue(a, [a, b])).toBe(a);
		expect(visibleIssue(a, [b])).toBeNull();
		expect(visibleIssue(null, [a])).toBeNull();
	});

	it("lands the first Down on the first row, not the second", () => {
		expect(stepIssueIndex(-1, 1, 3)).toBe(0);
		expect(stepIssueIndex(-1, -1, 3)).toBe(2);
		expect(stepIssueIndex(0, 1, 3)).toBe(1);
		expect(stepIssueIndex(2, 1, 3)).toBe(2);
		expect(stepIssueIndex(0, -1, 3)).toBe(0);
		expect(stepIssueIndex(-1, 1, 0)).toBeNull();
	});
});
