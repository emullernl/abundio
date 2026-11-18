import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc");

import { buildFilePaneLayout } from "../markdownPreview";

describe("buildFilePaneLayout", () => {
	it("opens a markdown file as one File pane, with no Preview pane", () => {
		const { layout, filePaneId } = buildFilePaneLayout("/w/README.md");
		expect(layout).toEqual({
			type: "file",
			id: filePaneId,
			filePath: "/w/README.md",
		});
	});

	it("pins the view when one is given", () => {
		const { layout } = buildFilePaneLayout("/w/README.md", "rendered");
		expect(layout.type === "file" && layout.markdownView).toBe("rendered");
	});

	it("gives a file that is not markdown no view", () => {
		const { layout } = buildFilePaneLayout("/w/app.ts", "rendered");
		expect(layout.type === "file" && layout.markdownView).toBeUndefined();
	});
});
