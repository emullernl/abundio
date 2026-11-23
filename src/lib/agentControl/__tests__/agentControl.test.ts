import { describe, expect, it } from "vitest";
import type { PaneNode, Tab } from "../../types";
import {
	controlStatus,
	describeAgent,
	describePane,
	type PaneLiveFacts,
} from "../describe";
import { resolveTarget, workspacePanes } from "../resolveTarget";
import { ControlError } from "../types";

function tab(id: string, position: number, layout: PaneNode): Tab {
	return {
		id,
		workspaceId: "ws",
		name: `Tab ${id}`,
		layoutJson: JSON.stringify(layout),
		position,
		createdAt: 0,
		updatedAt: 0,
	};
}

const term = (
	id: string,
	extra: Partial<Extract<PaneNode, { type: "terminal" }>> = {},
): PaneNode => ({ type: "terminal", id, ptyId: `pty-${id}`, ...extra });

const split = (first: PaneNode, second: PaneNode): PaneNode => ({
	type: "split",
	id: `s-${first.id}-${second.id}`,
	direction: "horizontal",
	ratio: 0.5,
	first,
	second,
});

const tabs = [
	tab("b", 1, term("c", { agentHandle: "reviewer", agentId: "codex" })),
	tab(
		"a",
		0,
		split(
			term("a"),
			split({ type: "file", id: "f", filePath: "/x" }, term("b")),
		),
	),
];

const numbers = new Map([
	["a", 1],
	["b", 2],
	["c", 5],
]);

describe("workspacePanes", () => {
	it("lists terminals Tab by Tab in Tab order, tree order inside, skipping file panes", () => {
		const panes = workspacePanes(tabs);
		expect(panes.map((p) => p.node.id)).toEqual(["a", "b", "c"]);
		expect(panes[2].tabName).toBe("Tab b");
	});

	it("skips a Tab whose layout does not parse", () => {
		const bad = { ...tabs[0], layoutJson: "not json" };
		expect(workspacePanes([bad]).length).toBe(0);
	});
});

describe("resolveTarget", () => {
	const panes = workspacePanes(tabs);

	it("finds a pane by number", () => {
		expect(
			resolveTarget({ kind: "pane", value: 2 }, panes, numbers).node.id,
		).toBe("b");
	});

	it("finds a pane by handle", () => {
		expect(
			resolveTarget({ kind: "handle", value: "reviewer" }, panes, numbers).node
				.id,
		).toBe("c");
	});

	it("misses an unknown number or handle with not_found", () => {
		for (const t of [
			{ kind: "pane", value: 3 } as const,
			{ kind: "handle", value: "nobody" } as const,
		]) {
			try {
				resolveTarget(t, panes, numbers);
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(ControlError);
				expect((e as ControlError).code).toBe("not_found");
			}
		}
	});

	it("does not find a number whose pane has closed", () => {
		const open = panes.filter((p) => p.node.id !== "b");
		expect(() =>
			resolveTarget({ kind: "pane", value: 2 }, open, numbers),
		).toThrow(ControlError);
	});
});

const facts = (over: Partial<PaneLiveFacts> = {}): PaneLiveFacts => ({
	state: "idle",
	mode: "shell",
	exited: false,
	detectedAgentId: null,
	cwd: null,
	title: null,
	runningCommand: null,
	...over,
});

describe("describePane", () => {
	const panes = workspacePanes([
		tab(
			"t",
			0,
			split(
				term("a", { cwd: "/repo" }),
				term("b", { agentId: "claude", agentHandle: "rev", spawnedBy: "a" }),
			),
		),
	]);

	it("describes a shell pane", () => {
		expect(
			describePane(panes[0], facts({ runningCommand: "make" }), numbers, "a"),
		).toEqual({
			pane: "p1",
			number: 1,
			handle: null,
			tab: "Tab t",
			self: true,
			mode: "shell",
			agent: null,
			status: "idle",
			cwd: "/repo",
			title: null,
			command: "make",
			spawnedBy: null,
			progress: null,
		});
	});

	it("describes an Agent pane, its owner by number", () => {
		const d = describePane(
			panes[1],
			facts({
				mode: "agent",
				state: "active",
				cwd: "/live",
				title: "Fixing",
				runningCommand: "claude",
			}),
			numbers,
			"a",
		);
		expect(d).toMatchObject({
			pane: "p2",
			handle: "rev",
			self: false,
			mode: "agent",
			agent: "claude",
			status: "working",
			cwd: "/live",
			title: "Fixing",
			command: null,
			spawnedBy: "p1",
		});
		expect(describeAgent(d)).not.toHaveProperty("mode");
	});

	it("falls back to the detected Agent id", () => {
		const d = describePane(
			panes[0],
			facts({ mode: "agent", detectedAgentId: "gemini" }),
			numbers,
			"x",
		);
		expect(d.agent).toBe("gemini");
	});
});

describe("controlStatus", () => {
	it("uses the glossary's words, and exited wins", () => {
		expect(controlStatus(facts({ state: "active" }))).toBe("working");
		expect(controlStatus(facts({ state: "waiting" }))).toBe("waiting");
		expect(controlStatus(facts({ state: null }))).toBe("idle");
		expect(controlStatus(facts({ state: "ready", exited: true }))).toBe(
			"exited",
		);
	});
});
