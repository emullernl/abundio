import { sameHandle } from "../agentHandle";
import { parseTabLayout } from "../paneTree";
import type { PaneNode, Tab } from "../types";
import { ControlError, type Target } from "./types";

export type TerminalNode = Extract<PaneNode, { type: "terminal" }>;

/** One terminal pane of a Workspace, with the Tab it sits in. */
export interface WorkspacePane {
	node: TerminalNode;
	tabId: string;
	tabName: string;
}

function terminalNodes(tree: PaneNode): TerminalNode[] {
	if (tree.type === "terminal") return [tree];
	if (tree.type !== "split") return [];
	return [...terminalNodes(tree.first), ...terminalNodes(tree.second)];
}

/**
 * Every terminal pane of a Workspace, Tab by Tab in Tab order, each Tab's
 * panes in tree order. This order is also the order new **Pane numbers** are
 * claimed in, so a Workspace's existing panes are numbered top to bottom the
 * first time an Agent looks.
 */
export function workspacePanes(tabs: readonly Tab[]): WorkspacePane[] {
	const sorted = [...tabs].sort((a, b) => a.position - b.position);
	const out: WorkspacePane[] = [];
	for (const tab of sorted) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;
		for (const node of terminalNodes(layout)) {
			out.push({ node, tabId: tab.id, tabName: tab.name });
		}
	}
	return out;
}

/**
 * The pane a target names, among the Workspace's current panes. `numbers`
 * maps pane id → Pane number. A number whose pane has closed is not found:
 * numbers are never reused, so it cannot name some other pane by accident.
 */
export function resolveTarget(
	target: Target,
	panes: readonly WorkspacePane[],
	numbers: ReadonlyMap<string, number>,
): WorkspacePane {
	if (target.kind === "pane") {
		const hit = panes.find((p) => numbers.get(p.node.id) === target.value);
		if (!hit) {
			throw new ControlError(
				"not_found",
				`no pane p${target.value} in this Workspace (it may have closed); run \`abundio pane list\``,
			);
		}
		return hit;
	}
	const hit = panes.find((p) => sameHandle(p.node.agentHandle, target.value));
	if (!hit) {
		throw new ControlError(
			"not_found",
			`no Agent named "${target.value}" in this Workspace; run \`abundio agent list\``,
		);
	}
	return hit;
}
