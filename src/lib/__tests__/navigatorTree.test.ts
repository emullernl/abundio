import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import {
	initialSelection,
	type NavigatorInput,
	type NavRow,
	navigatorRows,
	navigatorWorkspaceOrder,
	navStatusOf,
	parentKey,
} from "../navigatorTree";
import type { PaneNode, WorkspaceWithTabs } from "../types";
import type { WorkspaceRow } from "../worktreeGrouping";

function term(id: string, ptyId = "", cwd?: string): PaneNode {
	return { type: "terminal", id, ptyId, cwd } as PaneNode;
}
function file(id: string, filePath: string, isDiff = false): PaneNode {
	return { type: "file", id, filePath, isDiff } as PaneNode;
}
function split(first: PaneNode, second: PaneNode): PaneNode {
	return {
		type: "split",
		id: `s-${first.id}-${second.id}`,
		direction: "horizontal",
		ratio: 0.5,
		first,
		second,
	} as PaneNode;
}
function ws(id: string, tabs: [string, PaneNode][]): WorkspaceWithTabs {
	return {
		id,
		name: `ws-${id}`,
		rootFolder: `/${id}`,
		tabs: tabs.map(([tabId, layout], position) => ({
			id: tabId,
			workspaceId: id,
			name: `Tab ${tabId}`,
			layoutJson: JSON.stringify(layout),
			position,
			createdAt: 0,
			updatedAt: 0,
		})),
	} as unknown as WorkspaceWithTabs;
}
function agent(state: PtyActivityEntry["state"] = "idle"): PtyActivityEntry {
	return { detectionMode: "agent", state } as PtyActivityEntry;
}
function shell(): PtyActivityEntry {
	return { detectionMode: "shell", state: "idle" } as PtyActivityEntry;
}

const a = ws("a", [
	["a1", split(term("pa1", "x1"), term("pa2", "x2", "/a/src"))],
	["a2", split(file("pa3", "/a/README.md"), term("pa4", "x4"))],
]);
const b = ws("b", [["b1", term("pb1", "y1")]]);
const c = ws("c", [["c1", term("pc1", "")]]);

function input(over: Partial<NavigatorInput> = {}): NavigatorInput {
	return {
		workspaces: [a, b, c].map((workspace) => ({ workspace, linked: false })),
		openedWorkspaceIds: new Set(["a", "b"]),
		scope: "opened",
		query: "",
		statuses: new Set(),
		collapsed: new Set(),
		activities: {
			x1: agent("waiting"),
			x2: shell(),
			x4: agent("active"),
			y1: agent("ready"),
		},
		panePtyMap: {},
		titles: { pa1: "Fix login bug" },
		cwds: {},
		detectedAgentIds: { x1: "claude", x4: "codex", y1: "claude" },
		agentNames: { claude: "Claude Code", codex: "Codex" },
		branches: { a: "main", b: "feat/x" },
		fileWindows: [],
		...over,
	};
}

const keys = (rows: NavRow[]) => rows.map((r) => r.key);

describe("navigatorRows", () => {
	it("lists Opened workspaces as Workspace › Tab › Pane, fully expanded", () => {
		expect(keys(navigatorRows(input()))).toEqual([
			"ws:a",
			"tab:a1",
			"pane:pa1",
			"pane:pa2",
			"tab:a2",
			"pane:pa3",
			"pane:pa4",
			"ws:b",
			"tab:b1",
			"pane:pb1",
		]);
	});

	it("labels each pane kind", () => {
		const byKey = new Map(navigatorRows(input()).map((r) => [r.key, r]));
		const label = (k: string) => {
			const r = byKey.get(k);
			return r?.kind === "pane" ? [r.paneKind, r.label] : null;
		};
		expect(label("pane:pa1")).toEqual(["agent", "Fix login bug"]);
		expect(label("pane:pa2")).toEqual(["terminal", "src"]);
		expect(label("pane:pa3")).toEqual(["file", "README.md"]);
		expect(label("pane:pa4")).toEqual(["agent", "Codex"]);
	});

	it("widened scope adds non-Opened workspaces with no children", () => {
		const rows = navigatorRows(input({ scope: "all" }));
		const cRow = rows.find((r) => r.key === "ws:c");
		expect(cRow).toMatchObject({ opened: false, hasChildren: false });
		expect(
			rows.some((r) => r.workspaceId === "c" && r.kind !== "workspace"),
		).toBe(false);
	});

	it("collapsed rows hide their children", () => {
		const rows = navigatorRows(
			input({ collapsed: new Set(["ws:a", "tab:b1"]) }),
		);
		expect(keys(rows)).toEqual(["ws:a", "ws:b", "tab:b1"]);
		expect(rows[0]).toMatchObject({ expanded: false, hasChildren: true });
	});

	it("status filter keeps only matching Agents and drops empty parents", () => {
		const rows = navigatorRows(input({ statuses: new Set(["ready"]) }));
		expect(keys(rows)).toEqual(["ws:b", "tab:b1", "pane:pb1"]);
	});

	it("status filter hides terminal and file panes", () => {
		const rows = navigatorRows(
			input({ statuses: new Set(["waiting", "working"]) }),
		);
		expect(keys(rows)).toEqual([
			"ws:a",
			"tab:a1",
			"pane:pa1",
			"tab:a2",
			"pane:pa4",
		]);
	});

	it("status filter hides non-Opened workspaces in widened scope", () => {
		const rows = navigatorRows(
			input({ scope: "all", statuses: new Set(["idle"]) }),
		);
		expect(rows.some((r) => r.workspaceId === "c")).toBe(false);
	});

	it("search keeps a pane match with its ancestors", () => {
		const rows = navigatorRows(input({ query: "readme" }));
		expect(keys(rows)).toEqual(["ws:a", "tab:a2", "pane:pa3"]);
	});

	it("search on a Workspace name or branch shows its contents", () => {
		expect(keys(navigatorRows(input({ query: "feat/x" })))).toEqual([
			"ws:b",
			"tab:b1",
			"pane:pb1",
		]);
	});

	it("search matches Agent names and ignores collapse", () => {
		const rows = navigatorRows(
			input({ query: "codex", collapsed: new Set(["ws:a"]) }),
		);
		expect(keys(rows)).toEqual(["ws:a", "tab:a2", "pane:pa4"]);
	});

	it("search with no match returns nothing", () => {
		expect(navigatorRows(input({ query: "zzzzqq" }))).toEqual([]);
	});

	it("uses the live ptyId from panePtyMap", () => {
		const rows = navigatorRows(
			input({
				workspaces: [{ workspace: c, linked: false }],
				openedWorkspaceIds: new Set(["c"]),
				panePtyMap: { pc1: "z1" },
				activities: { z1: agent("error") },
				statuses: new Set(["error"]),
			}),
		);
		expect(keys(rows)).toEqual(["ws:c", "tab:c1", "pane:pc1"]);
	});
});

describe("File windows", () => {
	const fileWindows = [
		{
			label: "md-1",
			workspaceId: "a",
			kind: "text" as const,
			filePath: "/a/NOTES.md",
			commitOid: null,
		},
		{
			label: "md-2",
			workspaceId: "a",
			kind: "commit-diff" as const,
			filePath: "src/main.rs",
			commitOid: "abcdef1234",
		},
		{
			label: "md-3",
			workspaceId: "c",
			kind: "diff" as const,
			filePath: "x.ts",
			commitOid: null,
		},
	];

	it("lists a Workspace's windows after its Tabs", () => {
		const rows = navigatorRows(input({ fileWindows }));
		const a = rows.filter((r) => r.workspaceId === "a").map((r) => r.key);
		expect(a.slice(-2)).toEqual(["fw:md-1", "fw:md-2"]);
		const labels = rows
			.filter((r) => r.kind === "window")
			.map((r) => (r.kind === "window" ? r.label : ""));
		expect(labels).toEqual(["NOTES.md", "main.rs @ abcdef1"]);
		expect(parentKey(rows.find((r) => r.key === "fw:md-1") as NavRow)).toBe(
			"ws:a",
		);
	});

	it("are hidden by the status filter and by collapsing the Workspace", () => {
		expect(
			navigatorRows(
				input({ fileWindows, statuses: new Set(["waiting"]) }),
			).some((r) => r.kind === "window"),
		).toBe(false);
		expect(
			navigatorRows(input({ fileWindows, collapsed: new Set(["ws:a"]) })).some(
				(r) => r.kind === "window",
			),
		).toBe(false);
	});

	it("search matches the window's file and keeps the Workspace", () => {
		expect(keys(navigatorRows(input({ fileWindows, query: "notes" })))).toEqual(
			["ws:a", "fw:md-1"],
		);
	});

	it("a Workspace with only a window still has children", () => {
		const only = ws("d", []);
		const rows = navigatorRows(
			input({
				workspaces: [{ workspace: only, linked: false }],
				openedWorkspaceIds: new Set(["d"]),
				fileWindows: [{ ...fileWindows[0], workspaceId: "d" }],
			}),
		);
		expect(rows[0]).toMatchObject({ key: "ws:d", hasChildren: true });
		expect(keys(rows)).toEqual(["ws:d", "fw:md-1"]);
	});
});

describe("navigatorWorkspaceOrder", () => {
	it("flattens sets with Linked worktrees marked, even when folded", () => {
		const rows: WorkspaceRow[] = [
			{ kind: "standalone", workspace: a },
			{ kind: "set", groupKey: "g", primary: b, linked: [c] },
		];
		expect(
			navigatorWorkspaceOrder(rows).map((e) => [e.workspace.id, e.linked]),
		).toEqual([
			["a", false],
			["b", false],
			["c", true],
		]);
	});
});

describe("navStatusOf", () => {
	it("maps PTY states to filter states", () => {
		expect(navStatusOf(agent("active"))).toBe("working");
		expect(navStatusOf(agent("waiting"))).toBe("waiting");
		expect(navStatusOf(undefined)).toBe("idle");
	});
});

describe("selection helpers", () => {
	const rows = navigatorRows(input());
	it("preselects the target pane, else its Workspace", () => {
		expect(
			rows[initialSelection(rows, { paneId: "pa4", workspaceId: "a" })].key,
		).toBe("pane:pa4");
		expect(
			rows[initialSelection(rows, { paneId: "gone", workspaceId: "b" })].key,
		).toBe("ws:b");
		expect(initialSelection(rows, { paneId: null, workspaceId: null })).toBe(0);
	});
	it("parentKey walks up one level", () => {
		const pane = rows.find((r) => r.key === "pane:pa3") as NavRow;
		const tab = rows.find((r) => r.key === "tab:a2") as NavRow;
		expect(parentKey(pane)).toBe("tab:a2");
		expect(parentKey(tab)).toBe("ws:a");
		expect(parentKey(rows[0])).toBeNull();
	});
});
