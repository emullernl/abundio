import { describe, expect, it } from "vitest";
import { needsPtyResizeOnProject } from "../projectionResize";

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
