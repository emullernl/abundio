import { beforeEach, describe, expect, it, vi } from "vitest";

const dirty = vi.fn();
const save = vi.fn();
vi.mock("../../lib/ipc", () => ({
	fileWindows: {
		dirty: (...a: unknown[]) => dirty(...a),
		save: (...a: unknown[]) => save(...a),
	},
}));

import {
	confirmFileWindowsClean,
	describeFiles,
	resolveFileWindowClose,
	saveFailedMessage,
	useFileWindowCloseConfirmStore,
	waitUntil,
} from "../fileWindowCloseConfirmStore";

const one = [{ label: "md-1", filePath: "/r/README.md" }];

beforeEach(() => {
	dirty.mockReset();
	save.mockReset();
	useFileWindowCloseConfirmStore.setState({ pending: null, saveFailed: null });
});

describe("confirmFileWindowsClean", () => {
	it("proceeds at once when nothing is unsaved", async () => {
		dirty.mockResolvedValue([]);
		await expect(confirmFileWindowsClean(["w1"])).resolves.toBe(true);
		expect(useFileWindowCloseConfirmStore.getState().pending).toBeNull();
	});

	it("never blocks when it cannot ask", async () => {
		dirty.mockRejectedValue(new Error("ipc"));
		await expect(confirmFileWindowsClean(["w1"])).resolves.toBe(true);
	});

	it("asks, and Cancel stops the close", async () => {
		dirty.mockResolvedValue(one);
		const p = confirmFileWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useFileWindowCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		expect(
			useFileWindowCloseConfirmStore.getState().pending?.fileNames,
		).toEqual(["README.md"]);
		await resolveFileWindowClose("cancel");
		await expect(p).resolves.toBe(false);
	});

	it("Don't Save lets the close go ahead", async () => {
		dirty.mockResolvedValue(one);
		const p = confirmFileWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useFileWindowCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		await resolveFileWindowClose("discard");
		await expect(p).resolves.toBe(true);
		expect(save).not.toHaveBeenCalled();
	});

	it("Save asks the windows to save and waits until they are clean", async () => {
		dirty.mockResolvedValueOnce(one).mockResolvedValueOnce(one);
		dirty.mockResolvedValue([]);
		const p = confirmFileWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useFileWindowCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		await resolveFileWindowClose("save");
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

describe("a Save that does not land", () => {
	it("names the still-unsaved files and keeps the close from happening", async () => {
		vi.useFakeTimers();
		try {
			dirty.mockResolvedValue(one);
			save.mockResolvedValue(undefined);
			const p = confirmFileWindowsClean(["w1"]);
			await vi.waitFor(() =>
				expect(
					useFileWindowCloseConfirmStore.getState().pending,
				).not.toBeNull(),
			);
			const done = resolveFileWindowClose("save");
			await vi.advanceTimersByTimeAsync(6000);
			await done;
			await expect(p).resolves.toBe(false);
			expect(useFileWindowCloseConfirmStore.getState().saveFailed).toEqual([
				"README.md",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports every asked window when the save request itself fails", async () => {
		dirty.mockResolvedValueOnce(one).mockRejectedValue(new Error("ipc"));
		save.mockRejectedValue(new Error("ipc"));
		const p = confirmFileWindowsClean(["w1"]);
		await vi.waitFor(() =>
			expect(useFileWindowCloseConfirmStore.getState().pending).not.toBeNull(),
		);
		await resolveFileWindowClose("save");
		await expect(p).resolves.toBe(false);
		expect(useFileWindowCloseConfirmStore.getState().saveFailed).toEqual([
			"README.md",
		]);
	});
});

describe("saveFailedMessage", () => {
	it("says what failed and that nothing closed", () => {
		expect(saveFailedMessage(["a.md"])).toBe(
			"Abundio could not save a.md, so nothing was closed. Your edits are still in its File window. Check that the file can be written, then try again.",
		);
		expect(saveFailedMessage(["a.md", "b.md"])).toContain(
			"a.md and b.md, so nothing was closed. Your edits are still in their File windows.",
		);
	});
});
