import { describe, expect, it } from "vitest";
import {
	relativeToWorkspace,
	resolveWorkspacePath,
} from "../resolveWorkspacePath";

describe("relativeToWorkspace", () => {
	it("maps a posix path under the root", () => {
		expect(relativeToWorkspace("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
	});

	it("tolerates a trailing slash on the root", () => {
		expect(relativeToWorkspace("/repo/", "/repo/src/a.ts")).toBe("src/a.ts");
	});

	it("maps a Windows path with native separators", () => {
		// The pane's filePath comes from the Rust file explorer, which returns
		// native separators. Without normalising, this returned null and every
		// conflict affordance silently disappeared on Windows.
		expect(relativeToWorkspace("C:\\repo", "C:\\repo\\src\\a.ts")).toBe(
			"src/a.ts",
		);
	});

	it("returns a /-separated path, which is what git wants", () => {
		const rel = relativeToWorkspace("C:\\repo", "C:\\repo\\src\\lib\\a.ts");
		expect(rel).toBe("src/lib/a.ts");
		expect(rel).not.toContain("\\");
	});

	it("copes with the two sides disagreeing about separators", () => {
		expect(relativeToWorkspace("C:/repo", "C:\\repo\\src\\a.ts")).toBe(
			"src/a.ts",
		);
		expect(relativeToWorkspace("C:\\repo", "C:/repo/src/a.ts")).toBe(
			"src/a.ts",
		);
	});

	it("ignores drive-letter case, which Windows does too", () => {
		expect(relativeToWorkspace("C:\\repo", "c:\\repo\\a.ts")).toBe("a.ts");
	});

	it("stays case-sensitive on posix", () => {
		expect(relativeToWorkspace("/Repo", "/repo/a.ts")).toBeNull();
	});

	it("refuses a path outside the workspace", () => {
		expect(relativeToWorkspace("/repo", "/other/a.ts")).toBeNull();
		expect(relativeToWorkspace("/repo", "/a.ts")).toBeNull();
	});

	it("refuses a sibling whose name merely starts with the root", () => {
		// Segment-wise comparison: /repo-two is not inside /repo.
		expect(relativeToWorkspace("/repo", "/repo-two/a.ts")).toBeNull();
	});

	it("refuses the root itself", () => {
		expect(relativeToWorkspace("/repo", "/repo")).toBeNull();
		expect(relativeToWorkspace("/repo", "/repo/")).toBeNull();
	});
});

describe("resolveWorkspacePath", () => {
	it("joins onto a posix root", () => {
		expect(resolveWorkspacePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
	});

	it("strips a trailing separator of either kind", () => {
		expect(resolveWorkspacePath("/repo/", "a.ts")).toBe("/repo/a.ts");
		expect(resolveWorkspacePath("C:\\repo\\", "a.ts")).toBe("C:\\repo/a.ts");
	});

	it("round-trips with relativeToWorkspace", () => {
		for (const [root, rel] of [
			["/repo", "src/a.ts"],
			["C:\\repo", "src/a.ts"],
		]) {
			const abs = resolveWorkspacePath(root, rel);
			expect(relativeToWorkspace(root, abs)).toBe(rel);
		}
	});
});
