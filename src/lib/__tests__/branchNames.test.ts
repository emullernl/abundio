import { describe, expect, it } from "vitest";
import { isValidBranch } from "../worktreePath";
import names from "./fixtures/branchNames.json";

// The same table `valid_branch` in src-tauri/src/agent_control.rs is tested
// against, so `worktree new` and the dialogs agree on what a branch may be.
describe("branch names (shared with Rust)", () => {
	it.each(names.valid)("accepts %j", (b) => {
		expect(isValidBranch(b)).toBe(true);
	});
	it.each(names.invalid)("refuses %j", (b) => {
		expect(isValidBranch(b)).toBe(false);
	});
});
