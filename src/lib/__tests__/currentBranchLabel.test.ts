import { describe, expect, it } from "vitest";
import { branchLabel } from "../currentBranchLabel";

describe("branchLabel", () => {
	it("returns null when there is nothing to show", () => {
		expect(branchLabel(null)).toBeNull();
		expect(branchLabel(undefined)).toBeNull();
		expect(branchLabel("")).toBeNull();
		expect(branchLabel("   ")).toBeNull();
	});

	it("collapses the literal HEAD sentinel to detached", () => {
		expect(branchLabel("HEAD")).toEqual({ kind: "detached" });
	});

	it("leaves an unprefixed branch whole", () => {
		expect(branchLabel("main")).toEqual({
			kind: "branch",
			prefix: "",
			leaf: "main",
			full: "main",
		});
	});

	it("splits a prefixed branch on the last slash", () => {
		expect(branchLabel("feature/status-bar")).toEqual({
			kind: "branch",
			prefix: "feature/",
			leaf: "status-bar",
			full: "feature/status-bar",
		});
	});

	it("keeps every leading segment in the prefix when nested", () => {
		expect(branchLabel("emil/fix/nested-thing")).toEqual({
			kind: "branch",
			prefix: "emil/fix/",
			leaf: "nested-thing",
			full: "emil/fix/nested-thing",
		});
	});

	it("does not produce an empty leaf for a trailing slash", () => {
		expect(branchLabel("weird/")).toEqual({
			kind: "branch",
			prefix: "",
			leaf: "weird/",
			full: "weird/",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(branchLabel("  main  ")).toEqual({
			kind: "branch",
			prefix: "",
			leaf: "main",
			full: "main",
		});
	});
});
