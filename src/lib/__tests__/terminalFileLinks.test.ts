import { describe, expect, it } from "vitest";
import { findPathMatches, resolveAbsolute } from "../terminalFileLinks";

// The regex is intentionally permissive — it returns CANDIDATES that the
// caller then disambiguates by checking the workspace file index. So tests
// here cover what the regex captures structurally, not whether a given
// candidate is a "real" file.

describe("findPathMatches", () => {
	it("matches an absolute path", () => {
		const matches = findPathMatches(
			"see /Users/me/proj/src/foo.ts for details",
		);
		const paths = matches.map((m) => m.pathOnly);
		expect(paths).toContain("/Users/me/proj/src/foo.ts");
	});

	it("matches a relative path with extension", () => {
		const matches = findPathMatches("modified:   src/foo.ts");
		const paths = matches.map((m) => m.pathOnly);
		expect(paths).toContain("src/foo.ts");
	});

	it("matches bare basenames (ls output, agent prose)", () => {
		// `ls -al`-style output: bare names. Precision comes from the index
		// downstream — not every candidate becomes a link.
		const matches = findPathMatches(
			"-rw-r--r--  1 me  staff   456 Nov 22 14:32 README.md",
		);
		const paths = matches.map((m) => m.pathOnly);
		expect(paths).toContain("README.md");
	});

	it("matches ./ and ../ prefixed paths", () => {
		const matches = findPathMatches("run ./bin/cli ../shared/utils.ts");
		const paths = matches.map((m) => m.pathOnly);
		expect(paths).toContain("./bin/cli");
		expect(paths).toContain("../shared/utils.ts");
	});

	it("captures line:col annotation (grep style)", () => {
		const matches = findPathMatches("src/foo.ts:42:10: error message");
		const hit = matches.find((m) => m.pathOnly === "src/foo.ts");
		expect(hit).toBeDefined();
		expect(hit?.line).toBe(42);
		expect(hit?.col).toBe(10);
		expect(hit?.rawText).toBe("src/foo.ts:42:10");
	});

	it("captures (line,col) annotation (tsc style)", () => {
		const matches = findPathMatches("see src/main.rs(120,5) for context");
		const hit = matches.find((m) => m.pathOnly === "src/main.rs");
		expect(hit).toBeDefined();
		expect(hit?.line).toBe(120);
		expect(hit?.col).toBe(5);
	});

	it("captures bare :line annotation", () => {
		const matches = findPathMatches("at src/foo.ts:7");
		const hit = matches.find((m) => m.pathOnly === "src/foo.ts");
		expect(hit).toBeDefined();
		expect(hit?.line).toBe(7);
		expect(hit?.col).toBeNull();
	});

	it("finds multiple paths on one line", () => {
		const matches = findPathMatches("diff src/a.ts src/b.ts");
		const paths = matches.map((m) => m.pathOnly);
		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("src/b.ts");
	});

	it("records correct start/end indices for the whole match (incl. line)", () => {
		const line = "  src/foo.ts:42 done";
		const matches = findPathMatches(line);
		const hit = matches.find((m) => m.pathOnly === "src/foo.ts");
		expect(hit).toBeDefined();
		expect(line.slice(hit?.startIndex ?? 0, hit?.endIndex ?? 0)).toBe(
			"src/foo.ts:42",
		);
	});
});

describe("resolveAbsolute", () => {
	it("returns absolute paths unchanged (modulo normalisation)", () => {
		expect(resolveAbsolute("/a/b/c.ts", "/cwd")).toBe("/a/b/c.ts");
	});

	it("resolves a relative path against cwd", () => {
		expect(resolveAbsolute("src/foo.ts", "/work/proj")).toBe(
			"/work/proj/src/foo.ts",
		);
	});

	it("resolves ./ prefix", () => {
		expect(resolveAbsolute("./bin/cli", "/work/proj")).toBe(
			"/work/proj/bin/cli",
		);
	});

	it("walks .. segments", () => {
		// From cwd /work/proj/src, ../shared/utils.ts resolves up one level.
		expect(resolveAbsolute("../shared/utils.ts", "/work/proj/src")).toBe(
			"/work/proj/shared/utils.ts",
		);
	});

	it("returns null for a relative path with no cwd", () => {
		expect(resolveAbsolute("src/foo.ts", undefined)).toBeNull();
		expect(resolveAbsolute("src/foo.ts", "")).toBeNull();
	});

	it("expands ~/ when home is provided", () => {
		expect(resolveAbsolute("~/code/app.ts", "/anywhere", "/Users/me")).toBe(
			"/Users/me/code/app.ts",
		);
	});

	it("returns null for ~/ when home is missing", () => {
		expect(resolveAbsolute("~/code/app.ts", "/anywhere")).toBeNull();
	});

	it("collapses double slashes and trailing slashes", () => {
		expect(resolveAbsolute("//a///b/c.ts", "/cwd")).toBe("/a/b/c.ts");
	});
});
