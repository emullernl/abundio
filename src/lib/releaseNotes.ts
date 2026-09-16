import type { ReleaseNote } from "./ipc";

/**
 * Deciding *which* release notes to show, and under which heading. See ADR-0036.
 *
 * Rust fetches one page of published releases, newest first, and stops there.
 * This module owns the rest: it is pure, so every case below is a table test
 * with no network and no Tauri.
 *
 * The interesting cases are the two where the running version is missing from
 * the fetched page, because both are normal rather than exceptional:
 *  - **ahead** — a development build running a version newer than anything
 *    published. This is the daily state while working on Abundio, so it must
 *    not render an empty page.
 *  - **behind** — an install so stale its version fell off the single page we
 *    fetch. The list still means "what you have missed", so the anchor is kept
 *    in the heading and an "older releases" escape hatch is offered.
 */

/** How many releases Rust fetches. Mirrors `RELEASES_PAGE_SIZE` in updater.rs. */
export const RELEASES_PAGE_SIZE = 30;

export interface ReleaseNotesEntry {
	release: ReleaseNote;
	/** The release matching the version the user is running right now. */
	isCurrent: boolean;
	/** Open on first render. At most one entry is expanded by default. */
	defaultExpanded: boolean;
}

export interface ReleaseNotesView {
	/** Section heading. Says what the list *is*, which differs per case. */
	heading: string;
	entries: ReleaseNotesEntry[];
	/**
	 * The running version, when it has no published release of its own — a dev
	 * build, or one still in draft. Rendered as its own "no published release
	 * notes for vX" row. Null when the version *does* exist but simply fell off
	 * the fetched page: those notes are real, just not here, and claiming
	 * otherwise would be a lie.
	 */
	missingCurrentVersion: string | null;
	/** Offer the link out, because releases older than the page exist. */
	showOlderLink: boolean;
}

/** Splits `major.minor.patch`. Null for anything else — `scripts/release.sh`
 *  tags nothing else, so a version with a suffix is not one we can place.
 *  Mirrors `parse_version` in updater.rs; duplicated deliberately rather than
 *  spending an IPC round-trip on a three-integer compare (ADR-0036). */
function parseVersion(version: string): [number, number, number] | null {
	const parts = version.split(".");
	if (parts.length !== 3) return null;
	const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
	if (nums.some(Number.isNaN)) return null;
	return [nums[0], nums[1], nums[2]];
}

/** -1, 0 or 1. Unparseable versions sort as equal, so they never claim to be
 *  newer than something real. */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return 0;
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
	}
	return 0;
}

function entry(
	release: ReleaseNote,
	isCurrent: boolean,
	defaultExpanded: boolean,
): ReleaseNotesEntry {
	return { release, isCurrent, defaultExpanded };
}

/**
 * Picks the releases to render for a user on `currentVersion`.
 *
 * `releases` is newest-first as GitHub returns it, but nothing here relies on
 * that ordering being correct — everything is decided by comparing versions.
 */
export function selectReleaseNotes(
	currentVersion: string,
	releases: ReleaseNote[],
): ReleaseNotesView {
	const sorted = [...releases].sort((a, b) =>
		compareVersions(b.version, a.version),
	);
	const newer = sorted.filter(
		(r) => compareVersions(r.version, currentVersion) > 0,
	);
	const current = sorted.find((r) => r.version === currentVersion) ?? null;

	// The running version is published and on the page: show what is newer,
	// then it. Expand the newest thing the user has not got; when there is
	// nothing newer, expand what they are on, since that is all there is.
	if (current) {
		const entries = [
			...newer.map((r, i) => entry(r, false, i === 0)),
			entry(current, true, newer.length === 0),
		];
		return {
			heading: newer.length
				? `What's new since ${currentVersion}`
				: "Release notes",
			entries,
			missingCurrentVersion: null,
			showOlderLink: false,
		};
	}

	// Nothing published at all — a brand new repository, or a fetch that came
	// back empty. Nothing to anchor against.
	if (sorted.length === 0) {
		return {
			heading: "Release notes",
			entries: [],
			missingCurrentVersion: currentVersion,
			showOlderLink: false,
		};
	}

	// Behind: older than every release we fetched, so the running version's own
	// release exists but sits on a page we did not ask for. Everything fetched
	// is new to the user, and there is more beyond it.
	if (newer.length === sorted.length) {
		return {
			heading: `What's new since ${currentVersion}`,
			entries: sorted.map((r, i) => entry(r, false, i === 0)),
			missingCurrentVersion: null,
			showOlderLink: true,
		};
	}

	// Ahead: newer than everything published — a development build. Nothing is
	// "new to you", so the list is history rather than news and nothing opens.
	if (newer.length === 0) {
		return {
			heading: "Recent releases",
			entries: sorted.map((r) => entry(r, false, false)),
			missingCurrentVersion: currentVersion,
			showOlderLink: false,
		};
	}

	// Between two published releases without being one — a version that was
	// tagged but never released. Still answers "what have I missed".
	return {
		heading: `What's new since ${currentVersion}`,
		entries: newer.map((r, i) => entry(r, false, i === 0)),
		missingCurrentVersion: currentVersion,
		showOlderLink: false,
	};
}
