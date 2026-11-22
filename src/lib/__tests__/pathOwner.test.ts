import { describe, expect, it } from "vitest";
import { workspaceForPath } from "../pathOwner";

const own = (id: string, rootFolder: string) => ({ id, rootFolder });
const joined = (id: string, rootFolder: string) => ({
	id,
	rootFolder,
	joined: { hostId: "box" },
});

describe("workspaceForPath (ADR-0065: a Host never takes this computer's paths)", () => {
	it("routes a path to the deepest Workspace holding it", () => {
		const list = [own("a", "/Users/me/app"), own("b", "/Users/me/app/sub")];
		expect(workspaceForPath(list, "/Users/me/app/sub/x.ts")).toBe("b");
		expect(workspaceForPath(list, "/Users/me/app/x.ts")).toBe("a");
	});

	it("never lets a joined folder inside this computer's own take its paths", () => {
		const list = [
			own("mine", "/Users/me/app"),
			joined("theirs", "/Users/me/app/src"),
		];
		expect(workspaceForPath(list, "/Users/me/app/src/secret.ts")).toBe("mine");
	});

	it("gives a joined Workspace the paths no own Workspace holds", () => {
		const list = [
			own("mine", "/Users/me/app"),
			joined("theirs", "/home/dev/app"),
		];
		expect(workspaceForPath(list, "/home/dev/app/x.ts")).toBe("theirs");
		expect(workspaceForPath(list, "/etc/hosts")).toBeUndefined();
	});

	it("ignores a joined Workspace that claims the filesystem's root", () => {
		expect(
			workspaceForPath([joined("theirs", "/")], "/etc/passwd"),
		).toBeUndefined();
	});
});
