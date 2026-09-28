import { describe, expect, it } from "vitest";
import { buildRemoveWorkspaceMessage } from "../removeWorkspaceMessage";

describe("buildRemoveWorkspaceMessage", () => {
	it("says a single Workspace's folder stays on disk", () => {
		const msg = buildRemoveWorkspaceMessage("abundio", 0);
		expect(msg).toContain('"abundio" will be removed from your workspace list');
		expect(msg).toContain("No files or folders are deleted");
		expect(msg).toContain("the folder stays on disk");
		expect(msg).toContain("Its tabs, layout, notes and environment variables");
		expect(msg).not.toContain("worktree");
	});

	it("names the linked worktrees and says their folders stay on disk", () => {
		const msg = buildRemoveWorkspaceMessage("abundio", 2);
		expect(msg).toContain(
			'"abundio" and its 2 linked worktree workspaces will be removed',
		);
		expect(msg).toContain("No files or folders are deleted");
		expect(msg).toContain("the worktree folders stay on disk");
		expect(msg).toContain(
			"Their tabs, layouts, notes and environment variables",
		);
	});

	it("uses the singular for one linked worktree", () => {
		expect(buildRemoveWorkspaceMessage("abundio", 1)).toContain(
			"its 1 linked worktree workspace will be removed",
		);
	});
});
