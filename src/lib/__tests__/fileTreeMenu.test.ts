import { describe, expect, it } from "vitest";
import { fileTreeMenu } from "../fileTreeMenu";

const file = { isDir: false, name: "notes.md" };
const dir = { isDir: true, name: "src" };

describe("fileTreeMenu", () => {
	it("keeps the Explorer's full menu", () => {
		expect(
			fileTreeMenu({ entry: file, hasFileWindow: true, readOnly: false }),
		).toEqual([
			"open-tab",
			"open-beside",
			"open-below",
			"open-window",
			"separator",
			"reveal",
			"separator",
			"copy-path",
			"separator",
			"rename",
			"delete",
		]);
		expect(
			fileTreeMenu({
				entry: { isDir: false, name: "fix.patch" },
				hasFileWindow: false,
				readOnly: false,
			}),
		).toContain("open-diff");
		expect(
			fileTreeMenu({ entry: null, hasFileWindow: false, readOnly: false }),
		).toEqual(["new-file", "new-folder", "separator", "reveal-folder"]);
	});

	it("a read-only tree never creates, renames or deletes", () => {
		const changes = ["new-file", "new-folder", "rename", "delete"];
		for (const entry of [file, dir, null]) {
			const menu = fileTreeMenu({ entry, hasFileWindow: true, readOnly: true });
			expect(menu.filter((m) => changes.includes(m))).toEqual([]);
		}
		expect(
			fileTreeMenu({ entry: file, hasFileWindow: true, readOnly: true }),
		).toEqual([
			"open",
			"open-window",
			"separator",
			"reveal",
			"separator",
			"copy-path",
		]);
		expect(
			fileTreeMenu({ entry: dir, hasFileWindow: false, readOnly: true }),
		).toEqual(["reveal", "separator", "copy-path"]);
		expect(
			fileTreeMenu({ entry: null, hasFileWindow: false, readOnly: true }),
		).toEqual(["reveal-folder"]);
	});
});
