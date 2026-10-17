import { describe, expect, it } from "vitest";
import {
	diskChanged,
	diskRemoved,
	edited,
	isDirty,
	keptEdits,
	loadedBuffer,
	reloaded,
	savedBuffer,
} from "../markdownWindowBuffer";

describe("markdownWindowBuffer", () => {
	it("is clean when loaded and dirty once edited", () => {
		const b = loadedBuffer("# a");
		expect(isDirty(b)).toBe(false);
		expect(isDirty(edited(b, "# b"))).toBe(true);
		expect(isDirty(edited(b, "# a"))).toBe(false);
	});

	it("ignores its own save echoing back from the watcher", () => {
		const b = savedBuffer(edited(loadedBuffer("old"), "new"));
		const after = diskChanged(b, "new");
		expect(after.content).toBe("new");
		expect(after.externallyChanged).toBe(false);
	});

	it("reloads a clean buffer when someone else writes", () => {
		const after = diskChanged(loadedBuffer("old"), "theirs");
		expect(after.content).toBe("theirs");
		expect(isDirty(after)).toBe(false);
	});

	it("flags a dirty buffer instead of overwriting it", () => {
		const b = edited(loadedBuffer("old"), "mine");
		const after = diskChanged(b, "theirs");
		expect(after.content).toBe("mine");
		expect(after.externallyChanged).toBe(true);
		expect(after.pendingDisk).toBe("theirs");
	});

	it("reload takes the disk version", () => {
		const b = diskChanged(edited(loadedBuffer("old"), "mine"), "theirs");
		const r = reloaded(b);
		expect(r.content).toBe("theirs");
		expect(isDirty(r)).toBe(false);
	});

	it("keep edits stays dirty against the new disk version", () => {
		const b = diskChanged(edited(loadedBuffer("old"), "mine"), "theirs");
		const k = keptEdits(b);
		expect(k.content).toBe("mine");
		expect(k.saved).toBe("theirs");
		expect(k.externallyChanged).toBe(false);
		expect(isDirty(k)).toBe(true);
	});

	it("marks deletion and clears it when the file comes back", () => {
		const gone = diskRemoved(loadedBuffer("x"));
		expect(gone.deletedOnDisk).toBe(true);
		expect(diskChanged(gone, "x").deletedOnDisk).toBe(false);
	});
});
