import { describe, expect, it } from "vitest";
import {
	ago,
	BACKGROUND_CHECK_MS,
	canPull,
	checkIntervalMs,
	isDue,
	lastCheckedMs,
	pullOutcomeNotice,
	upstreamTooltip,
} from "../incomingCommits";
import type { UpstreamState } from "../types";

const up = (incoming: number, outgoing: number): UpstreamState => ({
	name: "origin/main",
	remote: "origin",
	incoming,
	outgoing,
	incomingCommits: [],
	lastFetched: null,
});

describe("checkIntervalMs", () => {
	it("is off at 0 minutes", () => {
		expect(checkIntervalMs(0, true)).toBeNull();
		expect(checkIntervalMs(0, false)).toBeNull();
	});
	it("uses the setting while focused and 2 h in the background", () => {
		expect(checkIntervalMs(30, true)).toBe(30 * 60_000);
		expect(checkIntervalMs(30, false)).toBe(BACKGROUND_CHECK_MS);
	});
});

describe("lastCheckedMs", () => {
	it("takes the later of our attempt and any fetch", () => {
		const u = { ...up(0, 0), lastFetched: 100 };
		expect(lastCheckedMs(undefined, u)).toBe(100_000);
		expect(lastCheckedMs(200_000, u)).toBe(200_000);
		expect(lastCheckedMs(50_000, u)).toBe(100_000);
		expect(lastCheckedMs(undefined, up(0, 0))).toBeNull();
	});
});

describe("isDue", () => {
	it("is due when never checked or old enough", () => {
		expect(isDue(null, 1000, 500)).toBe(true);
		expect(isDue(600, 1000, 500)).toBe(false);
		expect(isDue(500, 1000, 500)).toBe(true);
	});
});

describe("canPull", () => {
	it("needs incoming, no outgoing and nothing in progress", () => {
		expect(canPull(up(2, 0), null)).toBe(true);
		expect(canPull(up(0, 0), null)).toBe(false);
		expect(canPull(up(2, 1), null)).toBe(false);
		expect(canPull(up(2, 0), "rebase")).toBe(false);
		expect(canPull(null, null)).toBe(false);
	});
});

describe("upstreamTooltip", () => {
	const base = { lastMs: null, error: null, operationInProgress: null, now: 0 };
	it("says what Pull will do", () => {
		expect(upstreamTooltip(up(1, 0), base)).toContain(
			"Pull 1 commit from origin/main (fast-forward only).",
		);
	});
	it("explains a Diverged branch", () => {
		const t = upstreamTooltip(up(3, 2), base);
		expect(t).toContain("Diverged from origin/main");
		expect(t).toContain("rebase or merge in a terminal");
	});
	it("names a failed check and its age", () => {
		const t = upstreamTooltip(up(0, 0), {
			...base,
			lastMs: 0,
			now: 12 * 60_000,
			error: "Could not resolve host",
		});
		expect(t).toContain("Last checked 12 min ago.");
		expect(t).toContain("Last check failed: Could not resolve host");
	});
});

describe("ago", () => {
	it("is coarse", () => {
		expect(ago(0, 30_000)).toBe("just now");
		expect(ago(0, 5 * 60_000)).toBe("5 min ago");
		expect(ago(0, 3 * 3600_000)).toBe("3 hours ago");
		expect(ago(0, 72 * 3600_000)).toBe("3 days ago");
	});
});

describe("pullOutcomeNotice", () => {
	it("is silent on success", () => {
		expect(
			pullOutcomeNotice({ kind: "pulled", count: 2, upstream: "origin/main" }),
		).toBeNull();
		expect(
			pullOutcomeNotice({ kind: "upToDate", upstream: "origin/main" }),
		).toBeNull();
	});
	it("lists the files an overlap blocks on", () => {
		const n = pullOutcomeNotice({
			kind: "refused",
			reason: "overlap",
			files: ["a.txt", "src/b.ts"],
			upstream: "origin/main",
			outgoing: 0,
			incoming: 2,
		});
		expect(n?.files).toEqual(["a.txt", "src/b.ts"]);
		expect(n?.title).toBe("Pull would overwrite your changes");
	});
	it("explains every other refusal without files", () => {
		for (const reason of [
			"diverged",
			"operation",
			"detached",
			"noUpstream",
		] as const) {
			const n = pullOutcomeNotice({
				kind: "refused",
				reason,
				files: [],
				upstream: "origin/main",
				outgoing: 1,
				incoming: 1,
			});
			expect(n?.files).toEqual([]);
			expect(n?.message.length).toBeGreaterThan(0);
		}
	});
	it("carries git's message on a failure", () => {
		expect(
			pullOutcomeNotice({ kind: "fetchFailed", message: "Permission denied" })
				?.message,
		).toContain("Permission denied");
	});
});
