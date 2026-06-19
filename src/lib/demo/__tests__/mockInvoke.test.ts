import { describe, expect, it } from "vitest";
import type { PaneNode, WorkspaceWithTabs } from "../../types";
import { agentPanes, workspaces } from "../fixtures";
import { mockInvoke } from "../mockInvoke";

function collectPaneIds(node: PaneNode, into: Set<string>): void {
	into.add(node.id);
	if (node.type === "split") {
		collectPaneIds(node.first, into);
		collectPaneIds(node.second, into);
	}
}

function allPaneIds(): Set<string> {
	const ids = new Set<string>();
	for (const ws of workspaces) {
		for (const tab of ws.tabs) {
			collectPaneIds(JSON.parse(tab.layoutJson) as PaneNode, ids);
		}
	}
	return ids;
}

describe("mockInvoke", () => {
	it("returns typed profiles and workspaces", async () => {
		const profiles =
			await mockInvoke<{ id: string; name: string }[]>("profile_list");
		expect(profiles[0]).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				name: expect.any(String),
			}),
		);

		const ws = await mockInvoke<WorkspaceWithTabs[]>("workspace_list", {
			profileId: "demo-personal",
		});
		expect(ws[0]).toEqual(
			expect.objectContaining({
				id: expect.any(String),
				tabs: expect.any(Array),
			}),
		);
		// Every tab's layoutJson parses to a PaneNode with a discriminant.
		for (const tab of ws[0].tabs) {
			expect(JSON.parse(tab.layoutJson)).toHaveProperty("type");
		}
	});

	it("returns a git bundle and branch info", async () => {
		const bundle = await mockInvoke<{
			changedFiles: unknown[];
			branchInfo: unknown;
		}>("git_fetch_bundle", { cwd: "/Users/demo/code/acme-web" });
		expect(bundle.changedFiles).toEqual(expect.any(Array));
		expect(bundle.branchInfo).toEqual(
			expect.objectContaining({ defaultBranch: expect.any(String) }),
		);
	});

	it("serves a PR poller snapshot with both lists", async () => {
		expect(await mockInvoke("pr_poller_snapshot")).toEqual(
			expect.objectContaining({
				available: true,
				authenticated: true,
				reviewRequested: expect.any(Array),
				mine: expect.any(Array),
			}),
		);
	});

	it("intersects requested agent commands with installed ones", async () => {
		expect(
			await mockInvoke("list_installed_agent_commands", {
				commands: ["claude", "ls", "copilot"],
			}),
		).toEqual(["claude", "copilot"]);
	});

	it("returns the provided ptyId from pty_spawn", async () => {
		expect(
			await mockInvoke("pty_spawn", {
				logId: "pane-claude",
				ptyId: "pty-abc",
				cwd: "/x",
				cols: 80,
				rows: 24,
			}),
		).toBe("pty-abc");
	});

	it("treats mutating commands as inert no-ops", async () => {
		expect(
			await mockInvoke("fs_write_file", { path: "/x", content: "y" }),
		).toBeUndefined();
		expect(
			await mockInvoke("pty_write", { ptyId: "a", data: "b" }),
		).toBeUndefined();
		expect(
			await mockInvoke("workspace_update", { id: "a", updates: {} }),
		).toBeUndefined();
		expect(
			await mockInvoke("git_scheduler_start", {
				workspaceId: "a",
				rootPath: "/x",
			}),
		).toBeUndefined();
	});

	it("every demo agent pane exists in some layout (guards fixture drift)", () => {
		const ids = allPaneIds();
		for (const paneId of Object.keys(agentPanes)) {
			expect(ids.has(paneId)).toBe(true);
		}
	});
});
