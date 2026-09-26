import { describe, expect, it } from "vitest";
import type { ReleaseNote } from "../ipc";
import {
	compareVersions,
	missingNotesReason,
	releaseNoteForVersion,
	selectReleaseNotes,
} from "../releaseNotes";

function release(version: string, body = `notes for ${version}`): ReleaseNote {
	return {
		version,
		body,
		publishedAt: null,
		url: `https://example.test/${version}`,
	};
}

/** Newest first, as GitHub returns them. */
const RELEASES = [
	release("0.6.0"),
	release("0.5.0"),
	release("0.4.0"),
	release("0.3.0"),
];

describe("compareVersions", () => {
	it("compares numerically, not lexically", () => {
		expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
		expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
		expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
	});

	it("treats equal versions as equal", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});

	it("never claims an unreadable version is newer", () => {
		expect(compareVersions("nightly", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0", "nightly")).toBe(0);
		expect(compareVersions("1.2", "1.2.3")).toBe(0);
		expect(compareVersions("1.2.3-rc1", "1.2.3")).toBe(0);
	});
});

describe("selectReleaseNotes — the normal case", () => {
	const view = selectReleaseNotes("0.4.0", RELEASES);

	it("shows what is newer, then the running version", () => {
		expect(view.entries.map((e) => e.release.version)).toEqual([
			"0.6.0",
			"0.5.0",
			"0.4.0",
		]);
	});

	it("drops releases older than the running version", () => {
		expect(view.entries.map((e) => e.release.version)).not.toContain("0.3.0");
	});

	it("anchors the heading on the running version", () => {
		expect(view.heading).toBe("What's new since 0.4.0");
	});

	it("marks only the running version as current", () => {
		expect(view.entries.filter((e) => e.isCurrent)).toHaveLength(1);
		expect(view.entries.find((e) => e.isCurrent)?.release.version).toBe(
			"0.4.0",
		);
	});

	it("expands the newest release the user has not got", () => {
		expect(view.entries.filter((e) => e.defaultExpanded)).toHaveLength(1);
		expect(view.entries[0].defaultExpanded).toBe(true);
	});

	it("offers no older-releases link — the anchor was found", () => {
		expect(view.showOlderLink).toBe(false);
		expect(view.missingCurrentVersion).toBeNull();
	});
});

describe("selectReleaseNotes — up to date", () => {
	const view = selectReleaseNotes("0.6.0", RELEASES);

	it("shows only the running version's notes", () => {
		expect(view.entries).toHaveLength(1);
		expect(view.entries[0].release.version).toBe("0.6.0");
		expect(view.entries[0].isCurrent).toBe(true);
	});

	it("expands them, since they are all there is to read", () => {
		expect(view.entries[0].defaultExpanded).toBe(true);
	});

	it('does not say "since", because nothing is new', () => {
		expect(view.heading).toBe("Release notes");
	});
});

describe("selectReleaseNotes — ahead (a dev build)", () => {
	const view = selectReleaseNotes("0.7.0", RELEASES);

	it("still renders the published history rather than an empty page", () => {
		expect(view.entries.map((e) => e.release.version)).toEqual([
			"0.6.0",
			"0.5.0",
			"0.4.0",
			"0.3.0",
		]);
	});

	it("says the running version has no published notes", () => {
		expect(view.missingCurrentVersion).toBe("0.7.0");
	});

	it("calls the list history, not news", () => {
		expect(view.heading).toBe("Recent releases");
	});

	it("expands nothing — none of it is new to this user", () => {
		expect(view.entries.every((e) => !e.defaultExpanded)).toBe(true);
	});

	it("marks nothing as current, because nothing matches", () => {
		expect(view.entries.every((e) => !e.isCurrent)).toBe(true);
	});
});

describe("selectReleaseNotes — behind (fell off the fetched page)", () => {
	// hasMore: GitHub had releases beyond the page, so 0.1.0's own release is
	// real and simply not in this list.
	const view = selectReleaseNotes("0.1.0", RELEASES, true);

	it("shows everything fetched, since all of it is new to the user", () => {
		expect(view.entries).toHaveLength(4);
	});

	it("keeps the anchor in the heading", () => {
		expect(view.heading).toBe("What's new since 0.1.0");
	});

	it("offers the way to the releases it could not fetch", () => {
		expect(view.showOlderLink).toBe(true);
	});

	it("does not claim the version has no notes — they exist, off-page", () => {
		expect(view.missingCurrentVersion).toBeNull();
	});
});

describe("selectReleaseNotes — older than everything, but nothing more exists", () => {
	// Same shape as "behind", opposite truth: this is the whole of GitHub's
	// history, so 0.1.0 was never published rather than having fallen off a page.
	const view = selectReleaseNotes("0.1.0", RELEASES, false);

	it("does not point at older releases that do not exist", () => {
		expect(view.showOlderLink).toBe(false);
	});

	it("says plainly that this version has no published notes", () => {
		expect(view.missingCurrentVersion).toBe("0.1.0");
	});

	it("still lists everything, which is all genuinely newer", () => {
		expect(view.entries).toHaveLength(4);
		expect(view.heading).toBe("What's new since 0.1.0");
	});
});

describe("selectReleaseNotes — hasMore only speaks to the off-page case", () => {
	it("is ignored when the running version is present", () => {
		const withMore = selectReleaseNotes("0.4.0", RELEASES, true);
		const withoutMore = selectReleaseNotes("0.4.0", RELEASES, false);
		expect(withMore).toEqual(withoutMore);
		expect(withMore.showOlderLink).toBe(false);
	});

	it("is ignored for a dev build running ahead of everything", () => {
		const view = selectReleaseNotes("9.9.9", RELEASES, true);
		expect(view.heading).toBe("Recent releases");
		expect(view.missingCurrentVersion).toBe("9.9.9");
		expect(view.showOlderLink).toBe(false);
	});

	it("defaults to false, the conservative claim", () => {
		expect(selectReleaseNotes("0.1.0", RELEASES).showOlderLink).toBe(false);
	});
});

describe("selectReleaseNotes — a version between two releases", () => {
	// 0.4.5 was never released, but 0.5.0 and 0.6.0 came after it.
	const view = selectReleaseNotes("0.4.5", RELEASES);

	it("still answers what has been missed", () => {
		expect(view.entries.map((e) => e.release.version)).toEqual([
			"0.6.0",
			"0.5.0",
		]);
		expect(view.heading).toBe("What's new since 0.4.5");
	});

	it("says this version has no published notes of its own", () => {
		expect(view.missingCurrentVersion).toBe("0.4.5");
	});

	it("offers no older link — nothing fell off the page", () => {
		expect(view.showOlderLink).toBe(false);
	});
});

describe("selectReleaseNotes — nothing published", () => {
	const view = selectReleaseNotes("0.1.0", []);

	it("renders no entries and says so", () => {
		expect(view.entries).toEqual([]);
		expect(view.missingCurrentVersion).toBe("0.1.0");
		expect(view.heading).toBe("Release notes");
		expect(view.showOlderLink).toBe(false);
	});
});

describe("selectReleaseNotes — ordering", () => {
	it("does not trust the incoming order", () => {
		const shuffled = [release("0.4.0"), release("0.6.0"), release("0.5.0")];
		const view = selectReleaseNotes("0.4.0", shuffled);
		expect(view.entries.map((e) => e.release.version)).toEqual([
			"0.6.0",
			"0.5.0",
			"0.4.0",
		]);
	});

	it("sorts numerically across a version-number rollover", () => {
		const view = selectReleaseNotes("0.9.0", [
			release("0.9.0"),
			release("0.10.0"),
		]);
		expect(view.entries.map((e) => e.release.version)).toEqual([
			"0.10.0",
			"0.9.0",
		]);
	});

	it("never mutates the array it was given", () => {
		const input = [release("0.4.0"), release("0.6.0")];
		const snapshot = input.map((r) => r.version);
		selectReleaseNotes("0.4.0", input);
		expect(input.map((r) => r.version)).toEqual(snapshot);
	});
});

describe("releaseNoteForVersion", () => {
	it("returns the published note for the running version", () => {
		expect(releaseNoteForVersion("0.5.0", RELEASES)).toEqual(release("0.5.0"));
	});

	it("falls back to an empty note for an unpublished version", () => {
		const note = releaseNoteForVersion("0.7.0", RELEASES);
		expect(note.version).toBe("0.7.0");
		expect(note.body).toBe("");
		expect(note.url).toBe(
			"https://github.com/emullernl/abundio/releases/tag/v0.7.0",
		);
	});

	it("falls back when nothing was fetched", () => {
		expect(releaseNoteForVersion("0.5.0", []).body).toBe("");
	});
});

describe("missingNotesReason", () => {
	const page = { releases: RELEASES, hasMore: false };

	it("is null when the version is on the page", () => {
		expect(missingNotesReason("0.5.0", page, false)).toBeNull();
	});

	it("is null when an earlier page has the version despite a failed refresh", () => {
		expect(missingNotesReason("0.5.0", page, true)).toBeNull();
	});

	it("reports a failed fetch rather than claiming nothing was published", () => {
		expect(missingNotesReason("0.5.0", null, true)).toBe("failed");
	});

	it("reports an older version when more releases exist beyond the page", () => {
		expect(
			missingNotesReason("0.1.0", { releases: RELEASES, hasMore: true }, false),
		).toBe("older");
	});

	it("reports an unpublished version when the page is everything", () => {
		expect(missingNotesReason("0.7.0", page, false)).toBe("unpublished");
	});
});
