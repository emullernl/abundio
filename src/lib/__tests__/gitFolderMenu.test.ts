import { describe, expect, it } from "vitest";
import { gitFolderMenuEntries } from "../gitFolderMenu";

const labels = (existsOnDisk: boolean) =>
	gitFolderMenuEntries(existsOnDisk, "Reveal in Finder").map((e) =>
		"separator" in e ? "---" : `${e.label}${e.disabled ? " (disabled)" : ""}`,
	);

describe("gitFolderMenuEntries", () => {
	it("offers Reveal and both copies for a folder on disk", () => {
		expect(labels(true)).toEqual([
			"Reveal in Finder",
			"---",
			"Copy Relative Path",
			"Copy Path",
		]);
	});

	it("disables Reveal, never drops it, when the folder is gone", () => {
		expect(labels(false)).toEqual([
			"Reveal in Finder (disabled)",
			"---",
			"Copy Relative Path",
			"Copy Path",
		]);
	});
});
