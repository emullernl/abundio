import { describe, expect, it } from "vitest";
import { folderMissingReason } from "../missingFolder";

describe("folderMissingReason", () => {
	it("picks the refusal out of a spawn error", () => {
		expect(folderMissingReason("Folder not found: /Volumes/ssd/repo")).toBe(
			"Folder not found: /Volumes/ssd/repo",
		);
		expect(
			folderMissingReason(new Error("Folder not found: /Volumes/ssd/repo")),
		).toBe("Folder not found: /Volumes/ssd/repo");
	});

	it("is null for any other failure", () => {
		expect(folderMissingReason("PTY error: spawn failed")).toBeNull();
	});
});
