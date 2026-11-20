import { describe, expect, it } from "vitest";
import { lastPart, parentPath, pickableFolders } from "../remoteFolders";
import type { DirEntry } from "../types";

const entry = (name: string, isDir: boolean, isSymlink = false): DirEntry => ({
	name,
	path: `/h/${name}`,
	isDir,
	isSymlink,
	size: 0,
	extension: null,
});

describe("remote folder picking", () => {
	it("goes up to the root and no further", () => {
		expect(parentPath("/home/dev/src")).toBe("/home/dev");
		expect(parentPath("/home/dev/")).toBe("/home");
		expect(parentPath("/home")).toBe("/");
		expect(parentPath("/")).toBe("/");
	});
	it("names a folder by its last part", () => {
		expect(lastPart("/home/dev/my-app/")).toBe("my-app");
		expect(lastPart("/")).toBe("/");
	});
	it("lists folders and links, hidden ones on asking", () => {
		const list = [
			entry("src", true),
			entry(".git", true),
			entry("link", false, true),
			entry("README.md", false),
		];
		expect(pickableFolders(list, false).map((e) => e.name)).toEqual([
			"src",
			"link",
		]);
		expect(pickableFolders(list, true)).toHaveLength(3);
	});
});
