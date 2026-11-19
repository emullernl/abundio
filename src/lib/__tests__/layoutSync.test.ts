import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLayoutOps, type LayoutOp } from "../layoutOps";
import type { PaneNode } from "../types";

/** A stand-in for `layout_store.rs`: applies ops, all or nothing. */
const rust = vi.hoisted(() => ({
	tabs: new Map<string, { layout: unknown; version: number }>(),
	calls: [] as { tabId: string; ops: unknown[] }[],
	hold: null as null | Promise<void>,
}));

vi.mock("../ipc", () => ({
	layoutApi: {
		apply: async (tabId: string, ops: LayoutOp[]) => {
			rust.calls.push({ tabId, ops });
			if (rust.hold) await rust.hold;
			const e = rust.tabs.get(tabId) ?? { layout: null, version: 1 };
			const next = applyLayoutOps(e.layout as PaneNode, ops);
			if (next) {
				e.layout = next;
				e.version += 1;
			}
			rust.tabs.set(tabId, e);
			return {
				tabId,
				version: e.version,
				layoutJson: JSON.stringify(e.layout),
				applied: next !== null,
			};
		},
	},
}));

import {
	__resetLayoutSyncForTests,
	commitLayout,
	hasPendingLayoutOps,
	onLayoutFromRust,
	receiveLayoutChanged,
} from "../layoutSync";

const pane = (id: string, extra: object = {}) => ({
	type: "terminal",
	id,
	ptyId: "",
	...extra,
});
const split = (a: object, b: object) => ({
	type: "split",
	id: "s",
	direction: "vertical",
	ratio: 0.5,
	first: a,
	second: b,
});
const j = (v: unknown) => JSON.stringify(v);

describe("layout sync", () => {
	let taken: { tabId: string; layoutJson: string }[];

	beforeEach(() => {
		__resetLayoutSyncForTests();
		rust.tabs.clear();
		rust.calls = [];
		rust.hold = null;
		taken = [];
		onLayoutFromRust((tabId, layoutJson) => taken.push({ tabId, layoutJson }));
	});

	it("sends a Tab's first edit whole, then only what changed", async () => {
		await commitLayout("t", j(split(pane("a"), pane("b"))));
		await commitLayout("t", j(split(pane("a", { cwd: "/x" }), pane("b"))));
		expect(rust.calls.map((c) => c.ops)).toEqual([
			[{ op: "set", layout: split(pane("a"), pane("b")) }],
			[{ op: "patch", id: "a", set: { cwd: "/x" }, unset: [] }],
		]);
		expect(taken).toEqual([]);
	});

	it("sends nothing for an edit that changes nothing", async () => {
		await commitLayout("t", j(pane("a")));
		await commitLayout("t", j(pane("a")));
		expect(rust.calls).toHaveLength(1);
	});

	it("takes Rust's layout when it differs from the prediction, and says so", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await commitLayout("t", j(split(pane("a"), pane("b"))));
		// Another Client closed b in Rust's copy, unseen here.
		rust.tabs.set("t", { layout: pane("a"), version: 5 });
		await commitLayout("t", j(split(pane("a"), pane("b", { cwd: "/y" }))));
		expect(taken).toEqual([{ tabId: "t", layoutJson: j(pane("a")) }]);
		expect(warn).toHaveBeenCalledWith(
			"[layout] Rust did not apply the edit",
			undefined,
		);
		expect(warn).toHaveBeenCalledWith(
			"[layout] Rust corrected the Window's layout",
			{ tabId: "t" },
		);
		// The next edit is diffed against what Rust really has.
		await commitLayout("t", j(pane("a", { cwd: "/z" })));
		expect(rust.calls[rust.calls.length - 1]?.ops).toEqual([
			{ op: "patch", id: "a", set: { cwd: "/z" }, unset: [] },
		]);
		warn.mockRestore();
	});

	it("sends one batch at a time and compares only the last answer", async () => {
		let release!: () => void;
		rust.hold = new Promise((r) => {
			release = r;
		});
		const one = commitLayout("t", j(pane("a")));
		const two = commitLayout("t", j(pane("a", { cwd: "/x" })));
		await vi.waitFor(() => expect(rust.calls).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 10));
		expect(rust.calls).toHaveLength(1);
		expect(hasPendingLayoutOps("t")).toBe(true);
		release();
		await Promise.all([one, two]);
		expect(rust.calls).toHaveLength(2);
		expect(hasPendingLayoutOps("t")).toBe(false);
		expect(taken).toEqual([]);
	});

	it("takes another Window's edit, newest only, never over its own in flight", async () => {
		await commitLayout("t", j(pane("a")));
		const theirs = (version: number, cwd: string) => ({
			tabId: "t",
			version,
			layoutJson: j(pane("a", { cwd })),
			applied: true,
		});
		receiveLayoutChanged(theirs(9, "/new"));
		receiveLayoutChanged(theirs(8, "/old"));
		expect(taken.map((t) => JSON.parse(t.layoutJson).cwd)).toEqual(["/new"]);
		rust.hold = new Promise(() => {});
		void commitLayout("t", j(pane("a", { cwd: "/mine" })));
		receiveLayoutChanged(theirs(10, "/later"));
		expect(taken).toHaveLength(1);
	});

	it("takes an edit made elsewhere during its own without calling it a correction", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await commitLayout("t", j(split(pane("a"), pane("b"))));
		let release!: () => void;
		rust.hold = new Promise((r) => {
			release = r;
		});
		const mine = commitLayout(
			"t",
			j(split(pane("a", { cwd: "/x" }), pane("b"))),
		);
		// Rust renamed b meanwhile (Agent control), and told every Window.
		const e = rust.tabs.get("t");
		if (!e) throw new Error("no tab");
		e.layout = split(pane("a"), pane("b", { agentHandle: "New" }));
		receiveLayoutChanged({
			tabId: "t",
			version: 99,
			layoutJson: j(e.layout),
			applied: true,
		});
		release();
		await mine;
		expect(
			JSON.parse(taken[taken.length - 1].layoutJson).second.agentHandle,
		).toBe("New");
		expect(warn).not.toHaveBeenCalledWith(
			"[layout] Rust corrected the Window's layout",
			expect.anything(),
		);
		warn.mockRestore();
	});
});
