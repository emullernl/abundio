// **Title status** — a status an Agent announces in its own terminal title
// (GLOSSARY.md, ADR-0047). Pure: which titles mean what, per Agent, and what a
// title change should do to the pane. terminalManager feeds it
// `term.onTitleChange` and dispatches the result to the Status machine.

/** What a title says about the Agent's Turn. "none" means the title carries no
 *  status: the Turn is over, or the Agent is not announcing one. */
export type TitleStatus = "working" | "waiting" | "none";

interface TitleRule {
	match: "prefix" | "suffix";
	text: string;
	status: Exclude<TitleStatus, "none">;
}

// Mistral Vibe (vibe/cli/textual_ui/notifications/adapters/
// textual_notification_adapter.py): `>> <title>` while a Turn runs, `? <title>`
// while an approval prompt or question waits, the bare title otherwise. A
// *blurred* terminal swaps the prefix for a suffix once Vibe has rung its bell —
// `<title> - Action Required` (waiting) or `<title> - Task Complete` (Turn over,
// so no rule). Abundio passes focus reports through, so every background Vibe
// pane sees the suffix form. The prefixes need Vibe's
// `experimental_enable_tab_status` (default on); with it off only the suffixes
// remain, and only in unfocused panes.
const TITLE_RULES: Record<string, readonly TitleRule[]> = {
	vibe: [
		{ match: "prefix", text: ">> ", status: "working" },
		{ match: "prefix", text: "? ", status: "waiting" },
		{ match: "suffix", text: " - Action Required", status: "waiting" },
	],
};

/** Whether this Agent announces a Title status at all. */
export function hasTitleStatus(agentId: string | undefined): boolean {
	return agentId !== undefined && agentId in TITLE_RULES;
}

/** The Title status in `title`, or null when the Agent has no title rules. */
export function readTitleStatus(
	agentId: string | undefined,
	title: string,
): TitleStatus | null {
	if (!agentId) return null;
	const rules = TITLE_RULES[agentId];
	if (!rules) return null;
	for (const rule of rules) {
		const hit =
			rule.match === "prefix"
				? title.startsWith(rule.text)
				: title.endsWith(rule.text);
		if (hit) return rule.status;
	}
	return "none";
}

/** What one title change asks of the pane.
 *  - `dispatch`: the Title status to hand the Status machine, if it changed.
 *    `startsTurn` marks a Turn boundary (ADR-0027) — Working reached from
 *    anything but Waiting; an answered prompt resumes the same Turn.
 *  - `awaitTurnEnd`: the title lost its status, so the Turn ended — but not
 *    *how*. Wait briefly for the Agent's turn-finished hook (Ready); without
 *    one, the Turn was cancelled or failed (Idle). */
export interface TitleStep {
	dispatch: { status: TitleStatus; startsTurn: boolean } | null;
	awaitTurnEnd: boolean;
}

export function titleStep(
	prev: TitleStatus | null,
	next: TitleStatus,
): TitleStep {
	if (prev === next) return { dispatch: null, awaitTurnEnd: false };
	if (next === "none") {
		// A first plain title (the Agent's startup title) ends nothing.
		const wasBusy = prev === "working" || prev === "waiting";
		return {
			dispatch: wasBusy ? { status: "none", startsTurn: false } : null,
			awaitTurnEnd: wasBusy,
		};
	}
	return {
		dispatch: {
			status: next,
			startsTurn: next === "working" && prev !== "waiting",
		},
		awaitTurnEnd: false,
	};
}

/** How long a Turn end announced by the title waits for the turn-finished hook
 *  before it is read as a cancel or failure. The hook travels over loopback
 *  HTTP and the title through the PTY stream, so either may land first. */
export const TITLE_TURN_END_GRACE_MS = 1500;
