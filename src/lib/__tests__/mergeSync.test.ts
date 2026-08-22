import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getActiveConflictBlock,
	initialMergeSelection,
	setActiveConflictBlock,
	subscribeActiveConflictBlock,
} from "../mergeSync";

describe("initialMergeSelection", () => {
	it("starts at the first conflict when nothing is selected", () => {
		// Otherwise the Merge view opens on a uniformly dimmed file with no
		// region marked, which reads as broken.
		expect(initialMergeSelection(null, 3)).toBe(0);
	});

	it("respects a selection the caret already made", () => {
		expect(initialMergeSelection(2, 3)).toBe(2);
	});

	it("clamps a selection that outlived the blocks after it", () => {
		expect(initialMergeSelection(5, 3)).toBe(2);
	});

	it("selects nothing when there are no conflicts", () => {
		expect(initialMergeSelection(null, 0)).toBeNull();
		expect(initialMergeSelection(1, 0)).toBeNull();
	});

	it("treats a nonsense index as no selection", () => {
		expect(initialMergeSelection(-1, 3)).toBe(0);
	});
});

describe("active block registry", () => {
	beforeEach(() => {
		setActiveConflictBlock("pane-1", null);
		setActiveConflictBlock("pane-2", null);
	});

	it("keeps the value so it survives a pane re-parenting", () => {
		// Opening the Merge view unmounts and remounts the result pane. The
		// selection must outlive that, or the side panes appear with nothing
		// marked exactly when they are first shown.
		setActiveConflictBlock("pane-1", 2);
		expect(getActiveConflictBlock("pane-1")).toBe(2);
	});

	it("keeps panes independent", () => {
		setActiveConflictBlock("pane-1", 1);
		setActiveConflictBlock("pane-2", 4);
		expect(getActiveConflictBlock("pane-1")).toBe(1);
		expect(getActiveConflictBlock("pane-2")).toBe(4);
	});

	it("notifies subscribers only on a real change", () => {
		const fn = vi.fn();
		const unsubscribe = subscribeActiveConflictBlock("pane-1", fn);

		setActiveConflictBlock("pane-1", 1);
		expect(fn).toHaveBeenCalledTimes(1);

		// Same value again: no re-render for the side panes.
		setActiveConflictBlock("pane-1", 1);
		expect(fn).toHaveBeenCalledTimes(1);

		setActiveConflictBlock("pane-1", 2);
		expect(fn).toHaveBeenCalledTimes(2);

		unsubscribe();
		setActiveConflictBlock("pane-1", 3);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not notify another pane's subscribers", () => {
		const fn = vi.fn();
		subscribeActiveConflictBlock("pane-1", fn);
		setActiveConflictBlock("pane-2", 1);
		expect(fn).not.toHaveBeenCalled();
	});

	it("reports null for a pane that has never selected anything", () => {
		expect(getActiveConflictBlock("never-seen")).toBeNull();
	});
});
