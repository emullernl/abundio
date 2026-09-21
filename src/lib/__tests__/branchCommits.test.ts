import { describe, expect, it } from "vitest";
import {
	commitMenuEntries,
	commitTooltip,
	githubCommitUrl,
	initials,
	relativeTime,
} from "../branchCommits";

describe("initials", () => {
	it("takes the first and last word", () => {
		expect(initials("Emil Müller")).toBe("EM");
		expect(initials("Ada King Lovelace")).toBe("AL");
		expect(initials("cher")).toBe("C");
		expect(initials("  ")).toBe("?");
	});
	it("does not split a surrogate pair", () => {
		expect(initials("𝒜da Byron")).toBe("𝒜B");
	});
});

describe("relativeTime", () => {
	const now = 1_000_000_000;
	it.each([
		[now - 10, "now"],
		[now + 500, "now"],
		[now - 5 * 60, "5m"],
		[now - 3 * 3600, "3h"],
		[now - 2 * 86400, "2d"],
		[now - 21 * 86400, "3w"],
		[now - 120 * 86400, "4mo"],
		[now - 800 * 86400, "2y"],
	])("%i → %s", (then, want) => {
		expect(relativeTime(then, now)).toBe(want);
	});
});

describe("commitMenuEntries", () => {
	it("keeps one shape and disables Open on GitHub when it cannot apply", () => {
		const ids = (e: ReturnType<typeof commitMenuEntries>) =>
			e.map((x) => [x.id, x.disabled]);
		expect(ids(commitMenuEntries({ onRemote: true }, "o/r"))).toEqual([
			["copy-hash", false],
			["open-on-github", false],
		]);
		expect(ids(commitMenuEntries({ onRemote: false }, "o/r"))).toEqual([
			["copy-hash", false],
			["open-on-github", true],
		]);
		expect(ids(commitMenuEntries({ onRemote: true }, null))).toEqual([
			["copy-hash", false],
			["open-on-github", true],
		]);
	});
});

it("builds the GitHub commit URL", () => {
	expect(githubCommitUrl("o/r", "abc")).toBe(
		"https://github.com/o/r/commit/abc",
	);
});

it("tooltip leads with the short hash and ends with the full message", () => {
	const t = commitTooltip({
		oid: "9f3e1a7c0ffee",
		subject: "s",
		message: "s\n\nbody",
		authorName: "A B",
		authorEmail: "a@b",
		time: 0,
		isMerge: false,
		onRemote: false,
	});
	expect(t.startsWith("9f3e1a7 · A B <a@b> · ")).toBe(true);
	expect(t.endsWith("\n\ns\n\nbody")).toBe(true);
});
