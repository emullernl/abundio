/**
 * Pure helpers for the **Branch commits** section (see CONTEXT.md).
 *
 * The section's right-click menu follows the Git changes **Row menu**: it is
 * read-only (no revert, reset or cherry-pick — `Resolve & stage` stays
 * Abundio's only git write, ADR-0029), and an item that cannot apply is shown
 * disabled, never dropped, so the menu keeps one shape on every row.
 */

import type { BranchCommit } from "./types";

/** "Emil Müller" → "EM", "cher" → "C", "" → "?". First and last word, so a
 *  middle name does not push the surname out. */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	const first = Array.from(words[0])[0] ?? "";
	const last =
		words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
	return (first + last).toUpperCase();
}

/** Compact age for a narrow row: "now", "5m", "3h", "2d", "6w", "4mo", "2y".
 *  A time in the future (clock skew, a rebased author date) reads "now". */
export function relativeTime(thenSecs: number, nowSecs: number): string {
	const s = Math.max(0, nowSecs - thenSecs);
	if (s < 60) return "now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	if (d < 14) return `${d}d`;
	if (d < 60) return `${Math.floor(d / 7)}w`;
	if (d < 365) return `${Math.floor(d / 30)}mo`;
	return `${Math.floor(d / 365)}y`;
}

export function githubCommitUrl(slug: string, oid: string): string {
	return `https://github.com/${slug}/commit/${oid}`;
}

export type CommitMenuActionId = "copy-hash" | "open-on-github";

export interface CommitMenuAction {
	id: CommitMenuActionId;
	label: string;
	disabled: boolean;
}

/** `slug` is the Workspace's first GitHub `owner/repo`, or null. GitHub has
 *  no page for a commit that was never pushed, so that disables the item too. */
export function commitMenuEntries(
	commit: Pick<BranchCommit, "onRemote">,
	slug: string | null,
): CommitMenuAction[] {
	return [
		{ id: "copy-hash", label: "Copy Hash", disabled: false },
		{
			id: "open-on-github",
			label: "Open on GitHub",
			disabled: !slug || !commit.onRemote,
		},
	];
}

/** The row tooltip: short hash, author, local date, then the full message. */
export function commitTooltip(commit: BranchCommit): string {
	const date = new Date(commit.time * 1000).toLocaleString();
	const who = commit.authorEmail
		? `${commit.authorName} <${commit.authorEmail}>`
		: commit.authorName;
	return `${commit.oid.slice(0, 7)} · ${who} · ${date}\n\n${commit.message}`;
}
