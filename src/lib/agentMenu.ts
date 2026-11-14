// The **Agent menu**: what right-clicking an **Agent row** offers. Pure; the
// row maps each id to its action.

import type { RestartAgentResult } from "./paneRestart";

export type AgentMenuId =
	| "switch-to"
	| "open-in-fleet"
	| "rename"
	| "copy-handle"
	| "clear-flag"
	| "restart"
	| "close";

export type AgentMenuEntry =
	| { id: AgentMenuId; label: string }
	| { separator: true };

/** The menu's entries. Items that do not apply are left out, not greyed. */
export function agentMenuEntries(opts: {
	handle: string | undefined;
	flagged: boolean;
}): AgentMenuEntry[] {
	const entries: AgentMenuEntry[] = [
		{ id: "switch-to", label: "Switch To" },
		{ id: "open-in-fleet", label: "Open in Fleet Console" },
		{ separator: true },
		{ id: "rename", label: opts.handle ? "Rename Agent…" : "Name Agent…" },
	];
	if (opts.handle) entries.push({ id: "copy-handle", label: "Copy Handle" });
	if (opts.flagged) {
		entries.push({ id: "clear-flag", label: "Clear Attention Flag" });
	}
	entries.push(
		{ separator: true },
		{ id: "restart", label: "Restart Agent…" },
		{ id: "close", label: "Close Pane" },
	);
	return entries;
}

/** What to tell the user when a confirmed Restart agent did not happen. */
export function restartProblemText(
	result: RestartAgentResult,
	label: string,
): string | null {
	if (result === "no-pty") {
		return `${label} has no running terminal to restart. Open its Tab and try again.`;
	}
	if (result === "failed") return `${label} could not be restarted.`;
	return null;
}
