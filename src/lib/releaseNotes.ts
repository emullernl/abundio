import type { ReleaseNote, ReleaseNotesPage } from "./ipc";

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

/** Canonical GitHub release page for a version. */
export function releaseNotesUrl(version: string): string {
	return `https://github.com/emullernl/abundio/releases/tag/v${version}`;
}

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
	/**
	 * Whether GitHub had releases beyond the page we fetched. Comes from Rust,
	 * counted before filtering — the frontend cannot derive it, because a full
	 * page of 30 can arrive here as a handful of entries once prereleases and
	 * non-semver tags are dropped.
	 */
	hasMore = false,
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

	// Older than every release we fetched. Two very different situations, and
	// `hasMore` is the only thing that tells them apart:
	//
	//  - there are more releases beyond this page, so the running version's own
	//    release is real and simply sits on a page we did not ask for; or
	//  - this is everything GitHub has, so the running version was never
	//    published at all — and claiming "older releases on GitHub" would point
	//    at releases that do not exist, while suppressing the honest
	//    "no published release notes for vX" line.
	//
	// Either way everything fetched is new to the user, so the list is the same;
	// only the two claims we make around it differ.
	if (newer.length === sorted.length) {
		return {
			heading: `What's new since ${currentVersion}`,
			entries: sorted.map((r, i) => entry(r, false, i === 0)),
			missingCurrentVersion: hasMore ? null : currentVersion,
			showOlderLink: hasMore,
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

/**
 * The note to show when the user asks for the notes of the version they are
 * running — the status-bar version button (#203).
 *
 * Always returns a note, so the card always opens: a development build or an
 * unpublished version gets one with an empty `body`, which the card renders
 * as "no published notes" rather than silently doing nothing on click.
 */
export function releaseNoteForVersion(
	version: string,
	releases: ReleaseNote[],
): ReleaseNote {
	return (
		releases.find((r) => r.version === version) ?? {
			version,
			body: "",
			publishedAt: null,
			url: releaseNotesUrl(version),
		}
	);
}

/** Why the version button's card has no notes to show. */
export type MissingNotesReason =
	/** A development build, or a version tagged but never released. */
	| "unpublished"
	/** Published, but older than the one page of releases Rust fetches. */
	| "older"
	/** The fetch failed — offline, rate-limited, or GitHub is down. */
	| "failed";

/**
 * Null when `version` has notes on the fetched page. Otherwise the reason, so
 * the card never claims "no notes were published" for notes that exist.
 */
export function missingNotesReason(
	version: string,
	page: ReleaseNotesPage | null,
	fetchFailed: boolean,
): MissingNotesReason | null {
	if (page?.releases.some((r) => r.version === version)) return null;
	if (fetchFailed) return "failed";
	// `hasMore` only says a second page exists, not that the running version
	// is on it. Only a version older than everything fetched can be there; a
	// dev build ahead of every release (the "ahead" case in the module header)
	// or one between two releases was simply never published.
	const releases = page?.releases ?? [];
	const behindAll =
		releases.length > 0 &&
		releases.every((r) => compareVersions(r.version, version) > 0);
	return page?.hasMore && behindAll ? "older" : "unpublished";
}
