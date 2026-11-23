import { describe, expect, it } from "vitest";
import { fileTreeMenu } from "../fileTreeMenu";
import { gitRowMenuEntries } from "../gitRowMenu";
import { withoutLocalOnly } from "../localOnlyEntries";

describe("withoutLocalOnly (phase 10f: a Host's Workspace)", () => {
	it("keeps every entry on this computer", () => {
		const ids = fileTreeMenu({
			entry: { isDir: true, name: "src" },
			hasFileWindow: false,
			readOnly: false,
		});
		expect(withoutLocalOnly(ids, false)).toEqual(ids);
	});

	it("drops Reveal and the separators it leaves behind", () => {
		const dir = withoutLocalOnly(
			fileTreeMenu({
				entry: { isDir: true, name: "src" },
				hasFileWindow: false,
				readOnly: false,
			}),
			true,
		);
		expect(dir).toEqual([
			"new-file",
			"new-folder",
			"separator",
			"copy-path",
			"separator",
			"rename",
			"delete",
		]);
		const root = withoutLocalOnly(
			fileTreeMenu({ entry: null, hasFileWindow: false, readOnly: false }),
			true,
		);
		expect(root).toEqual(["new-file", "new-folder"]);
	});

	it("works on a Git row's menu too", () => {
		const entries = withoutLocalOnly(
			gitRowMenuEntries(
				{ path: "a.ts", status: "M", section: "unstaged" },
				"Reveal in Finder",
			),
			true,
		);
		expect(entries.some((e) => "id" in e && e.id === "reveal")).toBe(false);
		for (let i = 1; i < entries.length; i++) {
			expect("separator" in entries[i] && "separator" in entries[i - 1]).toBe(
				false,
			);
		}
	});
});
