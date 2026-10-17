import { beforeEach, describe, expect, it, vi } from "vitest";

const dirty = vi.fn();
const save = vi.fn();
vi.mock("../../lib/ipc", () => ({
	markdownWindows: {
		dirty: (...a: unknown[]) => dirty(...a),
		save: (...a: unknown[]) => save(...a),
	},
}));

import {
	confirmMarkdownWindowsClean,
	describeFiles,
	resolveMarkdownClose,
	useMarkdownCloseConfirmStore,
	waitUntil,
} from "../markdownCloseConfirmStore";

const one = [{ label: "md-1", filePath: "/r/README.md" }];

beforeEach(() => {
	dirty.mockReset();
	save.mockReset();
	useMarkdownCloseConfirmStore.setState({ pending: null });
});

describe("confirmMarkdownWindowsClean", () => {
	it("proceeds at once when nothing is unsaved", async () => {
		dirty.mockResolvedValue([]);
		await expect(confirmMarkdownWindowsClean(["w1"])).resolves.toBe(true);
		expect(useMarkdownCloseConfirmStore.getState().pending).toBeNull();
	});

	it("never blocks when it cannot ask", async () => {
		dirty.mockRejectedValue(new Error("ipc"));
		await expect(confirmMarkdownWindowsClean(["w1"])).resolves.toBe(true);
	});

	it("asks, and Cancel stops the close", async () => {
		dirty.mockResolvedValue(one);
		const p = confirmMarkdownWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useMarkdownCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		expect(useMarkdownCloseConfirmStore.getState().pending?.fileNames).toEqual([
			"README.md",
		]);
		await resolveMarkdownClose("cancel");
		await expect(p).resolves.toBe(false);
	});

	it("Don't Save lets the close go ahead", async () => {
		dirty.mockResolvedValue(one);
		const p = confirmMarkdownWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useMarkdownCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		await resolveMarkdownClose("discard");
		await expect(p).resolves.toBe(true);
		expect(save).not.toHaveBeenCalled();
	});

	it("Save asks the windows to save and waits until they are clean", async () => {
		dirty.mockResolvedValueOnce(one).mockResolvedValueOnce(one);
		dirty.mockResolvedValue([]);
		const p = confirmMarkdownWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useMarkdownCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		await resolveMarkdownClose("save");
		await expect(p).resolves.toBe(true);
		expect(save).toHaveBeenCalledWith(["md-1"]);
	});
});

describe("waitUntil", () => {
	it("gives up after the timeout", async () => {
		await expect(waitUntil(async () => false, 20, 5)).resolves.toBe(false);
	});
});

describe("describeFiles", () => {
	it("names one, two, or the first and a count", () => {
		expect(describeFiles(["a.md"])).toBe("a.md");
		expect(describeFiles(["a.md", "b.md"])).toBe("a.md and b.md");
		expect(describeFiles(["a.md", "b.md", "c.md"])).toBe("a.md and 2 others");
	});
});
