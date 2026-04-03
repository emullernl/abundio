import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerSnapshot,
	saveAllSnapshots,
	unregisterSnapshot,
} from "../snapshotRegistry";

vi.mock("../ipc", () => ({
	pty: {
		writeSnapshot: vi.fn(() => Promise.resolve()),
	},
}));

import { pty } from "../ipc";

const mockWriteSnapshot = vi.mocked(pty.writeSnapshot);

beforeEach(() => {
	mockWriteSnapshot.mockClear();
	// Clean up any registered snapshots
	unregisterSnapshot("pane-1");
	unregisterSnapshot("pane-2");
	unregisterSnapshot("pane-3");
});

describe("registerSnapshot / unregisterSnapshot", () => {
	it("registered snapshot is saved", async () => {
		registerSnapshot("pane-1", () => "snapshot-data");
		await saveAllSnapshots();
		expect(mockWriteSnapshot).toHaveBeenCalledWith("pane-1", "snapshot-data");
	});

	it("unregistered snapshot is not saved", async () => {
		registerSnapshot("pane-1", () => "snapshot-data");
		unregisterSnapshot("pane-1");
		await saveAllSnapshots();
		expect(mockWriteSnapshot).not.toHaveBeenCalled();
	});
});

describe("saveAllSnapshots", () => {
	it("saves multiple registered snapshots", async () => {
		registerSnapshot("pane-1", () => "data-1");
		registerSnapshot("pane-2", () => "data-2");
		await saveAllSnapshots();
		expect(mockWriteSnapshot).toHaveBeenCalledTimes(2);
		expect(mockWriteSnapshot).toHaveBeenCalledWith("pane-1", "data-1");
		expect(mockWriteSnapshot).toHaveBeenCalledWith("pane-2", "data-2");
	});

	it("skips snapshots that return undefined", async () => {
		registerSnapshot("pane-1", () => undefined);
		registerSnapshot("pane-2", () => "data-2");
		await saveAllSnapshots();
		expect(mockWriteSnapshot).toHaveBeenCalledTimes(1);
		expect(mockWriteSnapshot).toHaveBeenCalledWith("pane-2", "data-2");
	});

	it("continues saving other snapshots if one throws", async () => {
		registerSnapshot("pane-1", () => {
			throw new Error("fail");
		});
		registerSnapshot("pane-2", () => "data-2");
		await saveAllSnapshots();
		expect(mockWriteSnapshot).toHaveBeenCalledWith("pane-2", "data-2");
	});
});
