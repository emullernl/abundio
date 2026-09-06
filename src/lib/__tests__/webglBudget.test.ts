import { describe, expect, it } from "vitest";
import {
	MAX_WEBGL_CONTEXTS,
	pickWebglPanes,
	type WebglBudgetInput,
	webglReconcilePlan,
} from "../webglBudget";

/** A workspace with `tabs` tabs of `panesPerTab` panes, ids like `ws1-t0-p1`. */
function workspace(id: string, tabs: number, panesPerTab: number) {
	return {
		id,
		tabs: Array.from({ length: tabs }, (_, t) => ({
			id: `${id}-t${t}`,
			paneIds: Array.from(
				{ length: panesPerTab },
				(_, p) => `${id}-t${t}-p${p}`,
			),
		})),
	};
}

function pick(overrides: Partial<WebglBudgetInput> = {}) {
	return pickWebglPanes({
		workspaces: [],
		openedWorkspaceIds: new Set(),
		activeWorkspaceId: null,
		activeTabByWorkspace: {},
		...overrides,
	});
}

describe("pickWebglPanes", () => {
	it("gives every pane a context while the window stays under the cap", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 2, 2), workspace("ws2", 1, 2)],
			openedWorkspaceIds: new Set(["ws1", "ws2"]),
			activeWorkspaceId: "ws1",
		});
		expect(picked.size).toBe(6);
		expect(picked.has("ws2-t0-p1")).toBe(true);
	});

	it("ignores workspaces that are not opened", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 1, 2), workspace("ws2", 1, 2)],
			openedWorkspaceIds: new Set(["ws1"]),
			activeWorkspaceId: "ws1",
		});
		expect([...picked]).toEqual(["ws1-t0-p0", "ws1-t0-p1"]);
	});

	// The demo bootstrap opens far more panes than the browser has contexts;
	// before the cap they evicted each other in a loop and rendered blank.
	it("never hands out more contexts than the cap", () => {
		const workspaces = Array.from({ length: 12 }, (_, i) =>
			workspace(`ws${i}`, 1, 2),
		);
		const picked = pick({
			workspaces,
			openedWorkspaceIds: new Set(workspaces.map((w) => w.id)),
			activeWorkspaceId: "ws0",
		});
		expect(picked.size).toBe(MAX_WEBGL_CONTEXTS);
	});

	it("spends the budget on the active workspace first", () => {
		const workspaces = [workspace("cold", 1, 8), workspace("hot", 1, 8)];
		const picked = pick({
			workspaces,
			openedWorkspaceIds: new Set(["cold", "hot"]),
			activeWorkspaceId: "hot",
			cap: 8,
		});
		expect([...picked].every((id) => id.startsWith("hot-"))).toBe(true);
	});

	// A single workspace can hold more panes than the whole budget. What the
	// user is looking at still has to be the part that gets the GPU.
	it("prefers the active tab within a workspace", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 3, 2)],
			openedWorkspaceIds: new Set(["ws1"]),
			activeWorkspaceId: "ws1",
			activeTabByWorkspace: { ws1: "ws1-t2" },
			cap: 2,
		});
		expect([...picked]).toEqual(["ws1-t2-p0", "ws1-t2-p1"]);
	});

	it("falls back to tab order when no tab is marked active", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 3, 2)],
			openedWorkspaceIds: new Set(["ws1"]),
			activeWorkspaceId: "ws1",
			cap: 2,
		});
		expect([...picked]).toEqual(["ws1-t0-p0", "ws1-t0-p1"]);
	});

	it("still fills the budget when no workspace is active", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 1, 4)],
			openedWorkspaceIds: new Set(["ws1"]),
			activeWorkspaceId: null,
			cap: 3,
		});
		expect(picked.size).toBe(3);
	});

	// activeTabByWorkspace is persisted state and can name a tab that has since
	// been closed. Falling back to tab order keeps every pane eligible; dropping
	// the workspace would strand it on the DOM renderer.
	it("falls back to tab order when the active tab id is stale", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 2, 2)],
			openedWorkspaceIds: new Set(["ws1"]),
			activeWorkspaceId: "ws1",
			activeTabByWorkspace: { ws1: "ws1-t9-gone" },
			cap: 2,
		});
		expect([...picked]).toEqual(["ws1-t0-p0", "ws1-t0-p1"]);
	});

	it("ignores an active workspace that is not opened", () => {
		const picked = pick({
			workspaces: [workspace("ws1", 1, 2), workspace("ws2", 1, 2)],
			openedWorkspaceIds: new Set(["ws2"]),
			activeWorkspaceId: "ws1",
		});
		expect([...picked]).toEqual(["ws2-t0-p0", "ws2-t0-p1"]);
	});

	it("tolerates a tab with no panes", () => {
		const picked = pick({
			workspaces: [{ id: "ws1", tabs: [{ id: "ws1-t0", paneIds: [] }] }],
			openedWorkspaceIds: new Set(["ws1"]),
			activeWorkspaceId: "ws1",
		});
		expect(picked.size).toBe(0);
	});
});

describe("webglReconcilePlan", () => {
	const ids = (prefix: string, n: number) =>
		Array.from({ length: n }, (_, i) => `${prefix}${i}`);

	// The failure this function exists for: every slot is held by workspace A,
	// the user switches to workspace B, and B's panes must end up on the GPU. A
	// caller that interleaves load and unload refuses all of B (the cap is still
	// saturated when each is asked) and then frees all of A — zero contexts, the
	// visible workspace on the DOM renderer, nothing scheduled to fix it.
	it("frees every slot and refills it when the budget moves wholesale", () => {
		const loaded = new Set(ids("a", 12));
		const budget = new Set(ids("b", 12));
		const plan = webglReconcilePlan(loaded, budget);
		expect(plan.toUnload).toHaveLength(12);
		expect(plan.toLoad).toHaveLength(12);
	});

	it("keeps panes that are in both, and touches nothing else", () => {
		const plan = webglReconcilePlan(new Set(["a", "b"]), new Set(["a", "b"]));
		expect(plan).toEqual({ toUnload: [], toLoad: [] });
	});

	it("loads in the budget's priority order", () => {
		const plan = webglReconcilePlan(
			new Set(),
			new Set(["hot", "warm", "cold"]),
		);
		expect(plan.toLoad).toEqual(["hot", "warm", "cold"]);
	});

	it("unloads panes that fell out of the budget", () => {
		const plan = webglReconcilePlan(
			new Set(["stale", "keep"]),
			new Set(["keep"]),
		);
		expect(plan.toUnload).toEqual(["stale"]);
		expect(plan.toLoad).toEqual([]);
	});

	// Defence in depth: pickWebglPanes already caps the budget, but the plan must
	// not be the thing that overshoots if a caller passes a larger one.
	it("never loads past the cap", () => {
		const plan = webglReconcilePlan(new Set(), new Set(ids("p", 20)), 12);
		expect(plan.toLoad).toHaveLength(12);
	});

	it("counts contexts it is keeping against the cap", () => {
		const loaded = new Set(ids("keep", 10));
		const budget = new Set([...ids("keep", 10), ...ids("new", 5)]);
		const plan = webglReconcilePlan(loaded, budget, 12);
		expect(plan.toUnload).toEqual([]);
		expect(plan.toLoad).toEqual(["new0", "new1"]);
	});

	// How the reconciler expresses "GPU acceleration off".
	it("unloads everything for an empty budget", () => {
		const plan = webglReconcilePlan(new Set(["a", "b"]), new Set());
		expect(plan.toUnload).toEqual(["a", "b"]);
		expect(plan.toLoad).toEqual([]);
	});
});
