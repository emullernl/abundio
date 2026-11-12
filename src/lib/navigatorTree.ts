// The **Navigator**'s tree, pure: which rows are visible, in what order and
// at what depth, for a given scope, search, status filter and set of
// collapsed rows. The dialog renders exactly what this returns.

import type { PtyActivityEntry } from "../stores/ptyActivityStore";
import { agentRowTitle } from "./agentRowTitle";
import { fuzzyMatch } from "./fuzzyMatch";
import { parseTabLayout } from "./paneTree";
import type { PaneNode, WorkspaceWithTabs } from "./types";
import { rowWorkspaces, type WorkspaceRow } from "./worktreeGrouping";
import { basename } from "./worktreePath";

/** The Agent states the status filter offers. */
export type NavStatus = "waiting" | "working" | "ready" | "idle" | "error";

export const NAV_STATUSES: readonly NavStatus[] = [
	"waiting",
	"working",
	"ready",
	"idle",
	"error",
];

export type NavScope = "opened" | "all";

export type NavPaneKind = "agent" | "terminal" | "file" | "preview";

/** A Workspace in Left sidebar order. `linked` marks a Linked worktree,
 *  drawn indented under its Primary. */
export interface NavWorkspaceEntry {
	workspace: WorkspaceWithTabs;
	linked: boolean;
}

export type NavRow =
	| {
			kind: "workspace";
			key: string;
			workspaceId: string;
			name: string;
			branch: string | null;
			linked: boolean;
			opened: boolean;
			hasChildren: boolean;
			expanded: boolean;
	  }
	| {
			kind: "tab";
			key: string;
			workspaceId: string;
			tabId: string;
			name: string;
			linked: boolean;
			hasChildren: boolean;
			expanded: boolean;
	  }
	| {
			kind: "pane";
			key: string;
			workspaceId: string;
			tabId: string;
			paneId: string;
			paneKind: NavPaneKind;
			linked: boolean;
			/** The live ptyId of a terminal pane; "" otherwise. */
			ptyId: string;
			agentId: string | null;
			label: string;
	  }
	| {
			/** A **File window** of the Workspace: listed after its Tabs. */
			kind: "window";
			key: string;
			workspaceId: string;
			label: string;
			windowLabel: string;
			windowKind: NavFileWindow["kind"];
			linked: boolean;
	  };

/** An open File window, as Rust reports it. */
export interface NavFileWindow {
	label: string;
	workspaceId: string;
	kind: "text" | "image" | "diff" | "commit-diff";
	filePath: string;
	commitOid: string | null;
}

export interface NavigatorInput {
	workspaces: NavWorkspaceEntry[];
	openedWorkspaceIds: ReadonlySet<string>;
	scope: NavScope;
	query: string;
	statuses: ReadonlySet<NavStatus>;
	/** Keys of collapsed Workspace and Tab rows. Ignored while searching. */
	collapsed: ReadonlySet<string>;
	activities: Record<string, PtyActivityEntry>;
	panePtyMap: Record<string, string>;
	/** paneId → terminal title. */
	titles: Record<string, string>;
	/** ptyId → live folder. */
	cwds: Record<string, string>;
	/** ptyId → detected Agent id. */
	detectedAgentIds: Record<string, string>;
	/** Agent id → display name. */
	agentNames: Record<string, string>;
	/** Workspace id → current branch. */
	branches: Record<string, string | undefined>;
	/** Open File windows of the Opened workspaces. */
	fileWindows: readonly NavFileWindow[];
}

/** A File window's row text: the file name, marked for a diff. */
export function fileWindowLabel(w: NavFileWindow): string {
	const name = basename(w.filePath);
	if (w.kind === "diff") return `${name} (diff)`;
	if (w.kind === "commit-diff")
		return `${name} @ ${(w.commitOid ?? "").slice(0, 7)}`;
	return name;
}

/** The Left sidebar's order flattened, every Linked worktree included even
 *  inside a Folded set — a filter must never hide a live Agent. */
export function navigatorWorkspaceOrder(
	rows: WorkspaceRow[],
): NavWorkspaceEntry[] {
	const out: NavWorkspaceEntry[] = [];
	for (const row of rows) {
		rowWorkspaces(row).forEach((workspace, i) => {
			out.push({ workspace, linked: row.kind === "set" && i > 0 });
		});
	}
	return out;
}

/** The filter state of an Agent's PTY. A PTY with no entry yet is Idle. */
export function navStatusOf(entry: PtyActivityEntry | undefined): NavStatus {
	switch (entry?.state) {
		case "active":
			return "working";
		case "waiting":
			return "waiting";
		case "ready":
			return "ready";
		case "error":
			return "error";
		default:
			return "idle";
	}
}

type Leaf = Exclude<PaneNode, { type: "split" } | { type: "mergeSide" }>;

/** The panes the Navigator lists, in layout order. Merge side panes are
 *  part of their file pane's Merge view, not a place of their own. */
function leaves(node: PaneNode): Leaf[] {
	if (node.type === "split")
		return [...leaves(node.first), ...leaves(node.second)];
	if (node.type === "mergeSide") return [];
	return [node];
}

/** Parsed leaves by layout JSON. The tree is rebuilt on every title or
 *  status tick while the dialog is open, but a layout changes only when the
 *  user changes it, so parse each one once. Cleared when it grows past
 *  `LEAF_CACHE_MAX`, which only a long session of layout edits reaches. */
const leafCache = new Map<string, Leaf[]>();
const LEAF_CACHE_MAX = 500;

function leavesOf(layoutJson: string): Leaf[] {
	const cached = leafCache.get(layoutJson);
	if (cached) return cached;
	const layout = parseTabLayout(layoutJson);
	const out = layout ? leaves(layout) : [];
	if (leafCache.size >= LEAF_CACHE_MAX) leafCache.clear();
	leafCache.set(layoutJson, out);
	return out;
}

interface PaneFacts {
	paneKind: NavPaneKind;
	ptyId: string;
	agentId: string | null;
	label: string;
	/** Extra text the search matches but the row does not show. */
	searchText: string;
}

function describePane(
	leaf: Leaf,
	all: Leaf[],
	input: NavigatorInput,
): PaneFacts {
	if (leaf.type === "file") {
		const name = basename(leaf.filePath);
		return {
			paneKind: "file",
			ptyId: "",
			agentId: null,
			label: leaf.isDiff ? `${name} (diff)` : name,
			searchText: leaf.filePath,
		};
	}
	if (leaf.type === "preview") {
		const source = all.find((l) => l.id === leaf.sourcePaneId);
		const name =
			source?.type === "file" ? basename(source.filePath) : "markdown";
		return {
			paneKind: "preview",
			ptyId: "",
			agentId: null,
			label: `Preview · ${name}`,
			searchText: "",
		};
	}
	const ptyId = input.panePtyMap[leaf.id] ?? leaf.ptyId;
	const title = (input.titles[leaf.id] ?? "").trim();
	const isAgent = !!ptyId && input.activities[ptyId]?.detectionMode === "agent";
	if (isAgent) {
		const agentId = input.detectedAgentIds[ptyId] ?? leaf.agentId ?? null;
		const agentName = (agentId && input.agentNames[agentId]) || "Agent";
		return {
			paneKind: "agent",
			ptyId,
			agentId,
			label: agentRowTitle({ agentName, xtermTitle: title }),
			searchText: agentName,
		};
	}
	const folder = (ptyId && input.cwds[ptyId]) || leaf.cwd || "";
	return {
		paneKind: "terminal",
		ptyId,
		agentId: null,
		label: title || (folder ? basename(folder) : "Terminal"),
		searchText: folder,
	};
}

function matches(query: string, ...texts: (string | null | undefined)[]) {
	return texts.some((t) => !!t && fuzzyMatch(query, t) > 0);
}

/** The visible rows of the Navigator, top to bottom. */
export function navigatorRows(input: NavigatorInput): NavRow[] {
	const query = input.query.trim();
	const searching = query.length > 0;
	const filtering = input.statuses.size > 0;
	const rows: NavRow[] = [];

	for (const { workspace: ws, linked } of input.workspaces) {
		const opened = input.openedWorkspaceIds.has(ws.id);
		if (!opened && input.scope === "opened") continue;
		const branch = input.branches[ws.id] ?? null;
		const wsKey = `ws:${ws.id}`;
		const wsMatches = !searching || matches(query, ws.name, branch);

		// Tabs and their panes, already filtered.
		const tabBlocks: { header: NavRow; panes: NavRow[] }[] = [];
		if (opened) {
			for (const tab of ws.tabs) {
				const all = leavesOf(tab.layoutJson);
				const tabMatches = wsMatches || matches(query, tab.name);
				const panes: NavRow[] = [];
				for (const leaf of all) {
					const facts = describePane(leaf, all, input);
					if (filtering) {
						if (facts.paneKind !== "agent") continue;
						const st = navStatusOf(input.activities[facts.ptyId]);
						if (!input.statuses.has(st)) continue;
					}
					if (
						searching &&
						!tabMatches &&
						!matches(query, facts.label, facts.searchText)
					)
						continue;
					panes.push({
						kind: "pane",
						key: `pane:${leaf.id}`,
						workspaceId: ws.id,
						tabId: tab.id,
						paneId: leaf.id,
						paneKind: facts.paneKind,
						linked,
						ptyId: facts.ptyId,
						agentId: facts.agentId,
						label: facts.label,
					});
				}
				// A Tab stays when it has panes left, or — with no status filter —
				// when it matches the search itself.
				const keep = panes.length > 0 || (!filtering && tabMatches);
				if (!keep) continue;
				const tabKey = `tab:${tab.id}`;
				tabBlocks.push({
					header: {
						kind: "tab",
						key: tabKey,
						workspaceId: ws.id,
						tabId: tab.id,
						name: tab.name,
						linked,
						hasChildren: panes.length > 0,
						expanded: searching || !input.collapsed.has(tabKey),
					},
					panes,
				});
			}
		}

		// File windows hold no Agent, so the status filter hides them.
		const windowRows: NavRow[] =
			opened && !filtering
				? input.fileWindows
						.filter((w) => w.workspaceId === ws.id)
						.filter(
							(w) =>
								!searching ||
								wsMatches ||
								matches(query, fileWindowLabel(w), w.filePath),
						)
						.map((w) => ({
							kind: "window",
							key: `fw:${w.label}`,
							workspaceId: ws.id,
							label: fileWindowLabel(w),
							windowLabel: w.label,
							windowKind: w.kind,
							linked,
						}))
				: [];

		const keepWs =
			tabBlocks.length > 0 ||
			windowRows.length > 0 ||
			(!filtering && wsMatches);
		if (!keepWs) continue;
		const wsExpanded = searching || !input.collapsed.has(wsKey);
		rows.push({
			kind: "workspace",
			key: wsKey,
			workspaceId: ws.id,
			name: ws.name,
			branch,
			linked,
			opened,
			hasChildren: tabBlocks.length > 0 || windowRows.length > 0,
			expanded: wsExpanded,
		});
		if (!wsExpanded) continue;
		for (const block of tabBlocks) {
			rows.push(block.header);
			if (block.header.kind === "tab" && block.header.expanded) {
				rows.push(...block.panes);
			}
		}
		rows.push(...windowRows);
	}
	return rows;
}

/** A row that has children it can fold: a Workspace or a Tab. */
export function isFolder(
	row: NavRow,
): row is Extract<NavRow, { kind: "workspace" | "tab" }> {
	return row.kind === "workspace" || row.kind === "tab";
}

/** The key of a row's parent, or null for a Workspace row. */
export function parentKey(row: NavRow): string | null {
	if (row.kind === "workspace") return null;
	if (row.kind === "tab" || row.kind === "window")
		return `ws:${row.workspaceId}`;
	return `tab:${row.tabId}`;
}

/** The row to select when the Navigator opens: the target pane's, else its
 *  Tab's or Workspace's, else the first. */
export function initialSelection(
	rows: NavRow[],
	target: { paneId: string | null; workspaceId: string | null },
): number {
	if (target.paneId) {
		const i = rows.findIndex(
			(r) => r.kind === "pane" && r.paneId === target.paneId,
		);
		if (i >= 0) return i;
	}
	if (target.workspaceId) {
		const i = rows.findIndex(
			(r) => r.kind === "workspace" && r.workspaceId === target.workspaceId,
		);
		if (i >= 0) return i;
	}
	return 0;
}
