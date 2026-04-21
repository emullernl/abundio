import { describe, expect, it } from "vitest";
import { computeDesiredRoots, diffRoots } from "../useFileReloadWatcher";

describe("computeDesiredRoots", () => {
	it("includes only opened workspaces with a rootFolder", () => {
		const workspaces = [
			{ id: "a", rootFolder: "/a" },
			{ id: "b", rootFolder: "/b" },
			{ id: "c", rootFolder: "" },
		];
		const desired = computeDesiredRoots(workspaces, new Set(["a", "c"]));
		expect(desired.size).toBe(1);
		expect(desired.get("/a")).toBe("a");
	});

	it("is empty when nothing is opened", () => {
		const workspaces = [{ id: "a", rootFolder: "/a" }];
		const desired = computeDesiredRoots(workspaces, new Set());
		expect(desired.size).toBe(0);
	});

	it("keys by rootFolder so duplicate roots collapse", () => {
		const workspaces = [
			{ id: "a", rootFolder: "/shared" },
			{ id: "b", rootFolder: "/shared" },
		];
		const desired = computeDesiredRoots(workspaces, new Set(["a", "b"]));
		expect(desired.size).toBe(1);
	});
});

describe("diffRoots", () => {
	it("returns empty diff when active matches desired", () => {
		const active = new Set(["/a", "/b"]);
		const desired = new Map([
			["/a", "w1"],
			["/b", "w2"],
		]);
		expect(diffRoots(active, desired)).toEqual({ toStart: [], toStop: [] });
	});

	it("identifies additions", () => {
		const active = new Set<string>();
		const desired = new Map([["/a", "w1"]]);
		expect(diffRoots(active, desired)).toEqual({
			toStart: ["/a"],
			toStop: [],
		});
	});

	it("identifies removals", () => {
		const active = new Set(["/a"]);
		const desired = new Map<string, string>();
		expect(diffRoots(active, desired)).toEqual({
			toStart: [],
			toStop: ["/a"],
		});
	});

	it("handles simultaneous add and remove", () => {
		const active = new Set(["/a"]);
		const desired = new Map([["/b", "w2"]]);
		const { toStart, toStop } = diffRoots(active, desired);
		expect(toStart).toEqual(["/b"]);
		expect(toStop).toEqual(["/a"]);
	});
});
