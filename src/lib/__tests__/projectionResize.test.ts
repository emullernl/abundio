import { describe, expect, it } from "vitest";
import { needsPtyResizeOnProject, trackPtyResize } from "../projectionResize";

describe("needsPtyResizeOnProject", () => {
	it("skips the resize when a switch lands the pane at the size it left", () => {
		expect(
			needsPtyResizeOnProject({ gridChanged: false, sizedBefore: true }),
		).toBe(false);
	});

	it("resizes when the fit changed the grid", () => {
		expect(
			needsPtyResizeOnProject({ gridChanged: true, sizedBefore: true }),
		).toBe(true);
	});

	it("resizes a reconnected PTY once, even at an unchanged grid", () => {
		// Spawned by an earlier webview: its size is unknown.
		expect(
			needsPtyResizeOnProject({ gridChanged: false, sizedBefore: false }),
		).toBe(true);
	});
});

describe("trackPtyResize", () => {
	it("marks the PTY sized when the resize lands", async () => {
		const record = { ptySized: false };
		await trackPtyResize(record, () => Promise.resolve());
		expect(record.ptySized).toBe(true);
	});

	it("clears the mark when the resize fails, without rejecting", async () => {
		// Any resize path (zoom, font change, redraw nudge) can fail; the next
		// projection must then re-send the size even at an unchanged grid.
		const record = { ptySized: true };
		await expect(
			trackPtyResize(record, () => Promise.reject(new Error("ipc"))),
		).resolves.toBeUndefined();
		expect(record.ptySized).toBe(false);
		expect(
			needsPtyResizeOnProject({
				gridChanged: false,
				sizedBefore: record.ptySized,
			}),
		).toBe(true);
	});
});
