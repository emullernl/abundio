import type { PtyActivityEntry } from "../stores/ptyActivityStore";

/**
 * A **Busy PTY**: work is in flight. An **agent-mode PTY** that is Working, or
 * a **shell-mode PTY** with a command running.
 *
 * A pure function of one status entry, so the **Status indicator** and the
 * close confirmations can never disagree about whether a terminal is busy — and
 * a shell that has fallen silent mid-command still counts, because the Status
 * machine suppresses its idle backstop while a command runs. See ADR-0034.
 *
 * A **Waiting** agent is deliberately not Busy: it is blocked on the user, not
 * mid-turn. Quit is the one caller that also stops for a Waiting agent, and it
 * asks for that separately via `busyCounts().waiting`.
 */
export function isBusyPty(entry: PtyActivityEntry | undefined): boolean {
	if (!entry) return false;
	if (entry.detectionMode === "agent") return entry.state === "active";
	return entry.shellCommandRunning;
}

/** What each close confirmation needs to say, and to decide whether to appear
 *  at all. Counts, not booleans, because the dialogs name what is busy. */
export interface BusyCounts {
	/** Agent-mode PTYs mid-turn. */
	working: number;
	/** Agent-mode PTYs blocked on the user. Not Busy — see `isBusyPty` — but
	 *  quit stops for them anyway. */
	waiting: number;
	/** Shell-mode PTYs with a command in flight. */
	commands: number;
}

export const NO_BUSY: BusyCounts = { working: 0, waiting: 0, commands: 0 };

/** Tally a Window's live PTYs. Every entry in `activities` belongs to a live
 *  PTY — `removePty` drops an entry when its PTY dies — so there is nothing to
 *  filter by Workspace here. */
export function busyCounts(
	activities: Record<string, PtyActivityEntry>,
): BusyCounts {
	let working = 0;
	let waiting = 0;
	let commands = 0;
	for (const entry of Object.values(activities)) {
		if (entry.detectionMode === "agent") {
			if (entry.state === "active") working++;
			else if (entry.state === "waiting") waiting++;
		} else if (entry.shellCommandRunning) {
			commands++;
		}
	}
	return { working, waiting, commands };
}

/** Is anything **Busy**? The test for the Unload workspace and Close window
 *  confirmations. A Waiting agent does not count: unload and window close act
 *  on Workspaces the user is looking at and chose to close. */
export function hasBusyWork(c: BusyCounts): boolean {
	return c.working > 0 || c.commands > 0;
}

// Quit's own policy — the stricter "Busy *or* a Waiting agent" test and the
// cross-window sum — lives only in Rust (`BusyCounts::blocks_quit` and
// `BusyCountsState::total`), because the quit menu handler and its native
// dialog both run there. TypeScript deliberately keeps no second copy: two
// implementations of one rule with a caller on only one side is the drift
// ADR-0034 exists to remove.

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The clauses naming what is busy, most urgent first, zeroes omitted — e.g.
 *  "2 agents working, 1 agent waiting on you and 3 running commands". Returns
 *  an empty string when nothing is busy.
 *
 *  Mirrored by `window_management::describe_busy` in Rust, which words the
 *  native quit dialog. The duplication is unavoidable — that dialog is rendered
 *  from Rust and never sees this code — so **keep the two wordings in step**;
 *  they have no compiler or test tying them together. */
export function describeBusy(c: BusyCounts): string {
	const parts: string[] = [];
	if (c.working > 0) {
		parts.push(`${plural(c.working, "agent", "agents")} working`);
	}
	if (c.waiting > 0) {
		parts.push(`${plural(c.waiting, "agent", "agents")} waiting on you`);
	}
	if (c.commands > 0) {
		parts.push(plural(c.commands, "running command", "running commands"));
	}
	if (parts.length === 0) return "";
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Body text for the Close window confirmation, or `null` when nothing is busy
 *  and there is therefore no dialog to show. Returning `null` rather than a
 *  sentence with a hole in it puts "nothing busy means no dialog" in the type
 *  instead of a doc comment — the same contract `quit_confirm_message` carries
 *  on the Rust side. */
export function buildWindowCloseMessage(c: BusyCounts): string | null {
	const what = describeBusy(c);
	if (!what) return null;
	return `This window has ${what}. Closing it will terminate them.`;
}
