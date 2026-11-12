import { describe, expect, it } from "vitest";
import {
	checkHandle,
	handleForPane,
	handleGrammarProblem,
	isValidHandle,
} from "../agentHandle";
import { setAgentHandle, setAgentId } from "../paneTree";
import type { PaneNode, Tab } from "../types";

const tab = (id: string, layout: PaneNode): Tab => ({
	id,
	workspaceId: "ws",
	name: id,
	layoutJson: JSON.stringify(layout),
	position: 0,
	createdAt: 0,
	updatedAt: 0,
});

describe("handle grammar", () => {
	it("matches the Rust grammar", () => {
		for (const ok of [
			"a",
			"reviewer",
			"a-b_c9",
			"p",
			"px",
			"p1a",
			"a".repeat(32),
		]) {
			expect(isValidHandle(ok)).toBe(true);
			expect(handleGrammarProblem(ok)).toBeNull();
		}
		for (const bad of [
			"",
			"1a",
			"-a",
			"Rev",
			"a b",
			"a.b",
			"p1",
			"p0",
			"p007",
			"a".repeat(33),
		]) {
			expect(isValidHandle(bad)).toBe(false);
			expect(handleGrammarProblem(bad)).not.toBeNull();
		}
	});
});

describe("checkHandle", () => {
	const tabs = [
		tab("t1", { type: "terminal", id: "a", ptyId: "", agentHandle: "rev" }),
		tab("t2", { type: "terminal", id: "b", ptyId: "" }),
	];

	it("refuses a handle another pane in the Workspace has, across Tabs", () => {
		expect(checkHandle(tabs, "b", "rev")).toMatchObject({
			ok: false,
			code: "handle_taken",
		});
	});

	it("lets a pane keep its own handle, and take a free one", () => {
		expect(checkHandle(tabs, "a", "rev")).toEqual({ ok: true });
		expect(checkHandle(tabs, "b", "tester")).toEqual({ ok: true });
	});

	it("refuses bad grammar first", () => {
		expect(checkHandle(tabs, "b", "p3")).toMatchObject({
			ok: false,
			code: "invalid_handle",
		});
	});
});

describe("handleForPane", () => {
	it("finds a pane's handle across Workspaces", () => {
		const workspaces = [
			{
				tabs: [
					tab("t1", {
						type: "terminal",
						id: "a",
						ptyId: "",
						agentHandle: "rev",
					}),
				],
			},
			{ tabs: [tab("t2", { type: "terminal", id: "b", ptyId: "" })] },
		];
		expect(handleForPane(workspaces, "a")).toBe("rev");
		expect(handleForPane(workspaces, "b")).toBeUndefined();
	});
});

describe("handle in the layout", () => {
	const named: PaneNode = {
		type: "terminal",
		id: "a",
		ptyId: "",
		agentId: "claude",
		agentSessionId: "s1",
		agentHandle: "rev",
	};

	it("is set and cleared by setAgentHandle", () => {
		const bare: PaneNode = { type: "terminal", id: "a", ptyId: "" };
		const set = setAgentHandle(bare, "a", "rev");
		expect(set).toMatchObject({ agentHandle: "rev" });
		expect(setAgentHandle(set, "a", "rev")).toBe(set);
		expect(setAgentHandle(set, "a", undefined)).not.toHaveProperty(
			"agentHandle",
		);
		expect(setAgentHandle(set, "other", undefined)).toBe(set);
	});

	it("is cleared when the Agent leaves the pane", () => {
		expect(setAgentId(named, "a", undefined)).not.toHaveProperty("agentHandle");
	});

	it("is cleared when another Agent takes over", () => {
		expect(setAgentId(named, "a", "codex")).not.toHaveProperty("agentHandle");
	});

	it("survives the same Agent being stamped again", () => {
		expect(setAgentId(named, "a", "claude")).toBe(named);
	});

	it("is kept when a named pane gets its first Agent", () => {
		const pending: PaneNode = {
			type: "terminal",
			id: "a",
			ptyId: "",
			agentHandle: "rev",
		};
		expect(setAgentId(pending, "a", "claude")).toMatchObject({
			agentId: "claude",
			agentHandle: "rev",
		});
	});
});
