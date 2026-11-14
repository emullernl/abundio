import { describe, expect, it } from "vitest";
import type { Chord } from "../chords";
import {
	findConflict,
	type KeymapEntry,
	planRecording,
} from "../keymapConflicts";

const cmd = (key: string, shift = false): Chord => ({
	key,
	meta: true,
	shift,
	ctrl: false,
	alt: false,
});

const entries: KeymapEntry[] = [
	{
		id: "app:new-tab",
		label: "New tab",
		scope: "app",
		chord: cmd("t"),
		global: true,
	},
	{
		id: "app:search-in-terminal",
		label: "Find in terminal",
		scope: "app",
		chord: cmd("f"),
		global: false,
	},
	{
		id: "app:close-tab",
		label: "Close tab",
		scope: "app",
		chord: null,
		global: true,
	},
	{
		id: "editor:comment",
		label: "Toggle Line Comment",
		scope: "editor",
		chord: cmd("/"),
	},
	{ id: "editor:find", label: "Find", scope: "editor", chord: cmd("f") },
];

const target = (id: string): KeymapEntry =>
	entries.find((e) => e.id === id) as KeymapEntry;

describe("findConflict", () => {
	it("finds a same-scope clash", () => {
		const c = findConflict(target("app:search-in-terminal"), cmd("t"), entries);
		expect(c).toEqual({ kind: "clash", other: target("app:new-tab") });
	});

	it("is no conflict to rebind an action to its own chord", () => {
		expect(findConflict(target("app:new-tab"), cmd("t"), entries)).toBeNull();
	});

	it("ignores Unbound entries", () => {
		expect(findConflict(target("app:new-tab"), cmd("w"), entries)).toBeNull();
	});

	it("reports a workspace-global app action over an editor action as cross-scope", () => {
		const c = findConflict(target("app:new-tab"), cmd("/"), entries);
		expect(c?.kind).toBe("cross-scope");
		const back = findConflict(target("editor:comment"), cmd("t"), entries);
		expect(back?.kind).toBe("cross-scope");
	});

	it("lets a non-global app action share a chord with the editor", () => {
		// Find in terminal falls through to Monaco's Find while the editor has focus.
		expect(
			findConflict(target("editor:comment"), cmd("f"), entries)?.kind,
		).toBe("clash");
		const onlyApp = entries.filter((e) => e.id !== "editor:find");
		expect(
			findConflict(target("editor:comment"), cmd("f"), onlyApp),
		).toBeNull();
	});
});

describe("planRecording", () => {
	it("refuses before looking for conflicts", () => {
		expect(
			planRecording(target("app:new-tab"), cmd("q"), entries, true).kind,
		).toBe("refuse");
	});

	it("asks on a same-scope clash", () => {
		const plan = planRecording(
			target("app:search-in-terminal"),
			cmd("t"),
			entries,
			true,
		);
		expect(plan.kind).toBe("ask");
	});

	it("commits with a notice on a cross-scope clash", () => {
		const plan = planRecording(target("app:new-tab"), cmd("/"), entries, true);
		expect(plan.kind).toBe("commit");
		expect(plan.kind === "commit" && plan.notice).toMatch(/editor has focus/);
	});

	it("commits silently when free", () => {
		expect(
			planRecording(target("app:new-tab"), cmd("y", true), entries, true),
		).toEqual({
			kind: "commit",
			notice: null,
		});
	});
});

describe("Navigator Shortcut conflicts", () => {
	const navScope: KeymapEntry = {
		id: "app:navigator-toggle-scope",
		label: "Switch Opened / All workspaces",
		scope: "navigator",
		chord: { key: "Tab", meta: false, shift: false, ctrl: false },
	};
	const navWaiting: KeymapEntry = {
		id: "app:navigator-filter-waiting",
		label: "Toggle Waiting filter",
		scope: "navigator",
		chord: cmd("1"),
	};
	const prompt1: KeymapEntry = {
		id: "app:prompt-action-1",
		label: "Fire prompt action 1",
		scope: "app",
		chord: cmd("1"),
		standsDownUnderNavigator: true,
	};
	const all = [...entries, navScope, navWaiting, prompt1];

	it("shares a Chord with an app Shortcut that stands down", () => {
		expect(findConflict(navWaiting, cmd("1"), all)).toBeNull();
		expect(findConflict(prompt1, cmd("1"), all)).toBeNull();
	});

	it("clashes with an app Shortcut that still acts", () => {
		expect(findConflict(navWaiting, cmd("t"), all)).toEqual({
			kind: "clash",
			other: target("app:new-tab"),
		});
		expect(findConflict(target("app:new-tab"), cmd("1"), all)).toEqual({
			kind: "clash",
			other: navWaiting,
		});
	});

	it("clashes with another Navigator Shortcut", () => {
		expect(findConflict(navScope, cmd("1"), all)).toEqual({
			kind: "clash",
			other: navWaiting,
		});
	});

	it("never clashes with an editor Shortcut", () => {
		expect(findConflict(navWaiting, cmd("/"), all)).toBeNull();
	});

	it("records a bare Tab, which an app Shortcut may not", () => {
		const tab = { key: "Tab", meta: false, shift: false, ctrl: false };
		expect(planRecording(navScope, tab, all, true)).toEqual({
			kind: "commit",
			notice: null,
		});
		expect(planRecording(target("app:new-tab"), tab, all, true).kind).toBe(
			"refuse",
		);
	});
});
