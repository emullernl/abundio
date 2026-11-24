/**
 * Pure rules for **Incoming commits** and **Pull** (GLOSSARY.md, ADR-0066):
 * when to fetch, and what to say about an Upstream and a Pull's outcome.
 */
import type { PullOutcome, UpstreamState } from "./types";

/** A Window in the background checks this often, whatever the setting. */
export const BACKGROUND_CHECK_MS = 2 * 60 * 60 * 1000;
/** Gaining focus fetches only when the last check is older than this. */
export const FOCUS_STALE_MS = 5 * 60 * 1000;
/** The interval choices offered in Settings, in minutes; 0 is Off. */
export const INCOMING_CHECK_CHOICES = [0, 5, 15, 30, 60] as const;

/** How long between timer fetches; null when checking is Off. */
export function checkIntervalMs(
	minutes: number,
	focused: boolean,
): number | null {
	if (minutes <= 0) return null;
	const focusedMs = minutes * 60 * 1000;
	return focused ? focusedMs : Math.max(focusedMs, BACKGROUND_CHECK_MS);
}

/** The latest time we know the repository was checked: our own last attempt
 *  or a fetch from anywhere (a terminal, an Agent), as epoch ms. */
export function lastCheckedMs(
	ownAttemptMs: number | undefined,
	upstream: UpstreamState | null | undefined,
): number | null {
	const fetched = upstream?.lastFetched ? upstream.lastFetched * 1000 : null;
	if (ownAttemptMs === undefined) return fetched;
	return fetched === null ? ownAttemptMs : Math.max(ownAttemptMs, fetched);
}

/** Whether a check is due: never checked, or older than `intervalMs`. */
export function isDue(
	lastMs: number | null,
	now: number,
	intervalMs: number,
): boolean {
	return lastMs === null || now - lastMs >= intervalMs;
}

export function isDiverged(u: UpstreamState): boolean {
	return u.incoming > 0 && u.outgoing > 0;
}

/** Whether Pull is offered: there is something to bring in by moving forward. */
export function canPull(
	u: UpstreamState | null | undefined,
	operationInProgress: string | null,
): boolean {
	return !!u && u.incoming > 0 && u.outgoing === 0 && !operationInProgress;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** "12 min ago" style, coarse on purpose. */
export function ago(ms: number, now: number): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${plural(h, "hour")} ago`;
	return `${plural(Math.round(h / 24), "day")} ago`;
}

/** The tooltip on every ↓N / ↑M signal. */
export function upstreamTooltip(
	u: UpstreamState,
	opts: {
		lastMs: number | null;
		error: string | null;
		operationInProgress: string | null;
		now: number;
	},
): string {
	const lines: string[] = [];
	if (isDiverged(u)) {
		lines.push(
			`Diverged from ${u.name}: ${plural(u.incoming, "incoming commit")}, ${plural(u.outgoing, "outgoing commit")}.`,
			"Pull only fast-forwards; rebase or merge in a terminal.",
		);
	} else if (u.incoming > 0) {
		lines.push(
			opts.operationInProgress
				? `${plural(u.incoming, "incoming commit")} on ${u.name}. Finish the ${opts.operationInProgress.replace("_", "-")} first.`
				: `Pull ${plural(u.incoming, "commit")} from ${u.name} (fast-forward only).`,
		);
	} else if (u.outgoing > 0) {
		lines.push(`${plural(u.outgoing, "outgoing commit")} not on ${u.name}.`);
	} else {
		lines.push(`Up to date with ${u.name}.`);
	}
	lines.push(
		opts.lastMs === null
			? "Not checked yet. A repository nobody has fetched in is checked only by hand (Check for incoming commits)."
			: `Last checked ${ago(opts.lastMs, opts.now)}.`,
	);
	if (opts.error) lines.push(`Last check failed: ${opts.error}`);
	return lines.join("\n");
}

/** What the dialog says about a Pull that did not happen; null when there is
 *  nothing to tell (it pulled, or there was nothing to pull). */
export function pullOutcomeNotice(
	o: PullOutcome,
): { title: string; message: string; files: string[] } | null {
	switch (o.kind) {
		case "pulled":
		case "upToDate":
			return null;
		case "fetchFailed":
			return {
				title: "Couldn't check for new commits",
				message: `The fetch failed, so nothing was pulled. Git said: ${o.message}`,
				files: [],
			};
		case "failed":
			return {
				title: "Pull failed",
				message: `Git refused the fast-forward. Git said: ${o.message}`,
				files: [],
			};
		case "refused":
			switch (o.reason) {
				case "overlap":
					return {
						title: "Pull would overwrite your changes",
						message:
							"New commits change files you have uncommitted work in. Commit, stash or discard these first:",
						files: o.files,
					};
				case "diverged":
					return {
						title: "Branch has diverged",
						message: `${o.upstream ?? "The upstream"} has ${plural(o.incoming, "commit")} you don't have, and you have ${plural(o.outgoing, "commit")} it doesn't. Pull only fast-forwards; rebase or merge in a terminal.`,
						files: [],
					};
				case "operation":
					return {
						title: "Finish what's in progress first",
						message:
							"A merge, rebase, cherry-pick or revert is in progress. Finish or abort it, then pull.",
						files: [],
					};
				case "detached":
					return {
						title: "Not on a branch",
						message:
							"HEAD is detached, so there is no upstream to pull from. Check out a branch first.",
						files: [],
					};
				case "noUpstream":
					return {
						title: "No upstream",
						message:
							"This branch doesn't track a remote branch. Push it with `git push -u` first.",
						files: [],
					};
			}
	}
}
