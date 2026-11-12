// **Agent handle** rules (ADR-0054, ADR-0055). Rust has the same grammar
// (`agent_control::normalize_handle` / `handle_key`), and both are tested
// against `__tests__/fixtures/handleGrammar.json` so they cannot drift.

import { parseTabLayout } from "./paneTree";
import type { PaneNode, Tab } from "./types";

export const HANDLE_MAX_LENGTH = 32;

const PANE_LIKE = /^p[0-9]+$/i;
const ALLOWED = /^[A-Za-z0-9 _-]*$/;

/** Trimmed, with inner runs of spaces made one: the form a handle is stored
 *  and shown in. */
function tidy(s: string): string {
	return s.split(" ").filter(Boolean).join(" ");
}

/** Why `s` cannot be a handle, in words for the dialog; null when it can.
 *  Checks `s` as the user would have it stored (trimmed, spaces collapsed). */
export function handleGrammarProblem(s: string): string | null {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — control characters are refused
	if (/[\u0000-\u001F\u007F]/.test(s)) {
		return "Use letters, digits, spaces, - and _ only.";
	}
	const name = tidy(s);
	if (name === "") return "Enter a name.";
	if (name.length > HANDLE_MAX_LENGTH) {
		return `At most ${HANDLE_MAX_LENGTH} characters.`;
	}
	if (!/^[A-Za-z]/.test(name)) return "Start with a letter.";
	if (!ALLOWED.test(name)) {
		return "Use letters, digits, spaces, - and _ only.";
	}
	if (PANE_LIKE.test(name)) {
		return "That is how panes are numbered (p1, p2…). Pick another name.";
	}
	return null;
}

/** The handle as stored and shown, or null when `s` is not one. */
export function normalizeHandle(s: string): string | null {
	return handleGrammarProblem(s) === null ? tidy(s) : null;
}

/** Whether `s` is already a handle in its stored form. */
export function isValidHandle(s: string): boolean {
	return normalizeHandle(s) === s;
}

/** The form handles are matched and kept unique by: lowercase, every run of
 *  spaces and dashes one `-`. "Agent Two" and "agent-two" are one handle. */
export function handleKey(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/[ -]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Whether two handles name the same Agent. */
export function sameHandle(a: string | undefined, b: string): boolean {
	return a !== undefined && handleKey(a) === handleKey(b);
}

function handlesIn(tree: PaneNode, out: Map<string, string>): void {
	if (tree.type === "terminal") {
		if (tree.agentHandle) out.set(handleKey(tree.agentHandle), tree.id);
		return;
	}
	if (tree.type !== "split") return;
	handlesIn(tree.first, out);
	handlesIn(tree.second, out);
}

/** handle key → pane id, across every Tab of a Workspace. */
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
	const owner = workspaceHandles(tabs).get(handleKey(handle));
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
