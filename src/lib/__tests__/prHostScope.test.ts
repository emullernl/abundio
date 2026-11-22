import { describe, expect, it } from "vitest";
import { prHostNote, trackedWorkspaces } from "../prHostScope";

const local = {
	activeHostName: null,
	remoteHostName: null,
	profileHasHostWorkspaces: false,
};

describe("prHostNote", () => {
	it("blocks the repo view of a Workspace on a Host", () => {
		const n = prHostNote("repo", { ...local, activeHostName: "box" });
		expect(n.block).toContain("This Workspace is on box");
		expect(prHostNote("repo", local)).toEqual({ block: null, note: null });
	});

	it("blocks the profile view of a remote Window, notes joined Workspaces", () => {
		const remote = { ...local, activeHostName: "box", remoteHostName: "box" };
		expect(prHostNote("profile", remote).block).toContain(
			"This profile is on box",
		);
		const joined = prHostNote("profile", {
			...local,
			profileHasHostWorkspaces: true,
		});
		expect(joined).toEqual({
			block: null,
			note: "Workspaces on Hosts are not included.",
		});
	});

	it("leaves the account-wide view alone", () => {
		expect(
			prHostNote("all", {
				...local,
				activeHostName: "box",
				remoteHostName: "box",
			}),
		).toEqual({
			block: null,
			note: null,
		});
	});
});

describe("trackedWorkspaces", () => {
	it("keeps only this computer's Workspaces", () => {
		const list = [{ id: "a" }, { id: "b", joined: { hostId: "box" } }];
		expect(trackedWorkspaces(list, false).map((w) => w.id)).toEqual(["a"]);
		expect(trackedWorkspaces(list, true)).toEqual([]);
	});
});
