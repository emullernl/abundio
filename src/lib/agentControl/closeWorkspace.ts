// `abundio workspace close <name>`: the Agent's way to the Left sidebar's
// Close Workspace. The user is never asked (ADR-0054), so what the UI would
// ask about is refused instead: live work unless `--force`, unsaved edits
// always, since nobody can answer Save or Don't Save for the Agent.

import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import { isBusyPty } from "../busyPty";
import { ControlError } from "./types";

/** What stands in the way of closing a Workspace, each as a short label
 *  (`p2 Reviewer`, a file name). */
export interface CloseBlockers {
	/** Agents mid-turn. */
	working: string[];
	/** Agents blocked on a question to the user. Not Busy, but closing would
	 *  drop finished work with nobody watching (as at Quit). */
	waiting: string[];
	/** Shells with a command running. */
	commands: string[];
	/** Unsaved File panes and File windows of the Workspace. */
	unsaved: string[];
}

export const NO_BLOCKERS: CloseBlockers = {
	working: [],
	waiting: [],
	commands: [],
	unsaved: [],
};

/** Sort one PTY's status entry into `blockers` under `label`. */
export function addPtyBlocker(
	blockers: CloseBlockers,
	label: string,
	entry: PtyActivityEntry | undefined,
): void {
	if (!entry) return;
	if (entry.detectionMode === "agent") {
		if (entry.state === "waiting") blockers.waiting.push(label);
		else if (isBusyPty(entry)) blockers.working.push(label);
	} else if (isBusyPty(entry)) {
		blockers.commands.push(label);
	}
}

/** Why the close may not go ahead, or null when it may. */
export function closeWorkspaceRefusal(
	name: string,
	b: CloseBlockers,
	force: boolean,
): ControlError | null {
	if (b.unsaved.length > 0) {
		return new ControlError(
			"unsaved",
			`the Workspace ${JSON.stringify(name)} has unsaved edits (${b.unsaved.join(", ")}); ask the user to save or discard them. --force does not override this`,
		);
	}
	if (force) return null;
	const parts = [
		b.working.length && `working: ${b.working.join(", ")}`,
		b.waiting.length && `waiting for the user: ${b.waiting.join(", ")}`,
		b.commands.length && `running a command: ${b.commands.join(", ")}`,
	].filter(Boolean);
	if (parts.length === 0) return null;
	return new ControlError(
		"busy",
		`the Workspace ${JSON.stringify(name)} has live work (${parts.join("; ")}); closing stops it. Add --force only if the user asked`,
	);
}
