// **Agent handle** rules (ADR-0054). Rust checks the grammar too, for what
// reaches it through `abundio`; this copy serves the pane menu's dialog and
// the store, which Rust never sees.

import { parseTabLayout } from "./paneTree";
import type { PaneNode, Tab } from "./types";

export const HANDLE_MAX_LENGTH = 32;

/** `[a-z][a-z0-9_-]{0,31}`, and never a **Pane number** (`p` and digits
 *  only), so a handle and a number can never name different panes. */
export function isValidHandle(s: string): boolean {
	return /^[a-z][a-z0-9_-]{0,31}$/.test(s) && !/^p[0-9]+$/.test(s);
}

/** Why `s` cannot be a handle, in words for the dialog; null when it can. */
export function handleGrammarProblem(s: string): string | null {
	if (s === "") return "Enter a name.";
	if (s.length > HANDLE_MAX_LENGTH) {
		return `At most ${HANDLE_MAX_LENGTH} characters.`;
	}
	if (!/^[a-z]/.test(s)) return "Start with a lowercase letter.";
	if (!/^[a-z0-9_-]*$/.test(s)) {
		return "Use lowercase letters, digits, - and _ only.";
	}
	if (/^p[0-9]+$/.test(s)) {
		return "That is how panes are numbered (p1, p2…). Pick another name.";
	}
	return null;
}

function handlesIn(tree: PaneNode, out: Map<string, string>): void {
	if (tree.type === "terminal") {
		if (tree.agentHandle) out.set(tree.agentHandle, tree.id);
		return;
	}
	if (tree.type !== "split") return;
	handlesIn(tree.first, out);
	handlesIn(tree.second, out);
}

/** handle → pane id, across every Tab of a Workspace. */
export function workspaceHandles(tabs: readonly Tab[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const tab of tabs) {
		const layout = parseTabLayout(tab.layoutJson);
		if (layout) handlesIn(layout, out);
	}
	return out;
}

export type HandleCheck =
	| { ok: true }
	| { ok: false; code: "invalid_handle" | "handle_taken"; message: string };

/** Whether `paneId` may take `handle` in a Workspace with these Tabs. A pane
 *  may keep (re-set) its own handle. */
export function checkHandle(
	tabs: readonly Tab[],
	paneId: string,
	handle: string,
): HandleCheck {
	const grammar = handleGrammarProblem(handle);
	if (grammar) return { ok: false, code: "invalid_handle", message: grammar };
	const owner = workspaceHandles(tabs).get(handle);
	if (owner && owner !== paneId) {
		return {
			ok: false,
			code: "handle_taken",
			message: `Another Agent in this Workspace is already called "${handle}".`,
		};
	}
	return { ok: true };
}

let lastWorkspaces: readonly { tabs: readonly Tab[] }[] | null = null;
let lastByPane = new Map<string, string>();

/**
 * The Agent handle of `paneId`, if any, among these Workspaces. Every title
 * bar asks on every Workspace change, so the pane → handle map is built once
 * per `workspaces` array and shared.
 */
export function handleForPane(
	workspaces: readonly { tabs: readonly Tab[] }[],
	paneId: string,
): string | undefined {
	if (workspaces !== lastWorkspaces) {
		lastWorkspaces = workspaces;
		lastByPane = new Map();
		for (const ws of workspaces) {
			for (const [handle, pane] of workspaceHandles(ws.tabs)) {
				lastByPane.set(pane, handle);
			}
		}
	}
	return lastByPane.get(paneId);
}
