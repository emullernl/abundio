import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
	Channel: class {},
}));

import { issues } from "../ipc";

describe("issues.list: git names the repository, this computer's gh lists it", () => {
	beforeEach(() => invoke.mockReset());

	it("asks git for the repository, then lists its issues by name", async () => {
		// git runs on the Workspace's backend (a host command, through
		// `host_call`); gh_list_issues is this computer's own command.
		invoke.mockImplementation(async (cmd: string) =>
			cmd === "host_call" ? "acme/web" : [{ number: 7 }],
		);
		await expect(issues.list("/home/dev/web")).resolves.toEqual([
			{ number: 7 },
		]);
		expect(invoke).toHaveBeenCalledWith(
			"host_call",
			expect.objectContaining({
				command: "git_repo_slug",
				args: { cwd: "/home/dev/web" },
			}),
		);
		expect(invoke).toHaveBeenCalledWith("gh_list_issues", { repo: "acme/web" });
	});

	it("says so when the folder has no GitHub remote, without calling gh", async () => {
		invoke.mockResolvedValue(null);
		await expect(issues.list("/x")).rejects.toThrow("no GitHub remote");
		expect(invoke).not.toHaveBeenCalledWith(
			"gh_list_issues",
			expect.anything(),
		);
	});
});
