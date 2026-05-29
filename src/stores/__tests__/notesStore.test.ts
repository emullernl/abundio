import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotesStore } from "../notesStore";

vi.mock("../../lib/ipc", () => ({
	notes: {
		get: vi.fn(),
		set: vi.fn().mockResolvedValue(undefined),
	},
}));

import { notes } from "../../lib/ipc";

function resetStore() {
	useNotesStore.setState({
		contentByWorkspaceId: {},
		loadedWorkspaceIds: new Set(),
	});
}

describe("notesStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		resetStore();
	});

	it("loadNote populates the cache and marks loaded", async () => {
		vi.mocked(notes.get).mockResolvedValueOnce("stored-json");
		await useNotesStore.getState().loadNote("w1");
		expect(notes.get).toHaveBeenCalledWith("w1");
		expect(useNotesStore.getState().contentByWorkspaceId.w1).toBe(
			"stored-json",
		);
		expect(useNotesStore.getState().loadedWorkspaceIds.has("w1")).toBe(true);
	});

	it("loadNote is a no-op once loaded", async () => {
		vi.mocked(notes.get).mockResolvedValue("once");
		await useNotesStore.getState().loadNote("w1");
		await useNotesStore.getState().loadNote("w1");
		expect(notes.get).toHaveBeenCalledTimes(1);
	});

	it("updateNoteLocal updates cache without persisting immediately", () => {
		vi.useFakeTimers();
		useNotesStore.getState().updateNoteLocal("w1", "typed");
		expect(useNotesStore.getState().contentByWorkspaceId.w1).toBe("typed");
		expect(notes.set).not.toHaveBeenCalled();
	});

	it("updateNoteLocal persists after the debounce window", () => {
		vi.useFakeTimers();
		useNotesStore.getState().updateNoteLocal("w1", "typed");
		vi.advanceTimersByTime(500);
		expect(notes.set).toHaveBeenCalledWith("w1", "typed");
	});

	it("flushNote persists current content and cancels the pending debounce", async () => {
		vi.useFakeTimers();
		useNotesStore.getState().updateNoteLocal("w1", "latest");
		await useNotesStore.getState().flushNote("w1");
		expect(notes.set).toHaveBeenCalledTimes(1);
		expect(notes.set).toHaveBeenCalledWith("w1", "latest");
		// The debounce timer must not fire a second write afterwards.
		vi.advanceTimersByTime(500);
		expect(notes.set).toHaveBeenCalledTimes(1);
	});
});
