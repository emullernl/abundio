import { describe, expect, it } from "vitest";
import {
	clampPeekExplorerWidth,
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_PANES_MIN,
	ORCHESTRATOR_TAB_STRIP,
	PEEK_EXPLORER_DEFAULT,
	PEEK_EXPLORER_MAX,
	PEEK_EXPLORER_MIN,
	PEEK_TERMINAL_MIN,
	panesTop,
	peekExplorerDragWidth,
	peekExplorerShownWidth,
	ratioFor,
	topContentHeight,
} from "../orchestratorLayout";

describe("orchestratorLayout", () => {
	const room = (view: number) =>
		view - ORCHESTRATOR_TAB_STRIP - ORCHESTRATOR_DIVIDER;

	it("splits the room by the ratio, half by default", () => {
		expect(topContentHeight(0.5, false, 1000)).toBe(Math.round(room(1000) / 2));
		expect(topContentHeight(0.25, false, 1000)).toBe(
			Math.round(room(1000) / 4),
		);
	});
	it("shrinks the top so the panes keep their minimum", () => {
		const view = 400;
		const h = topContentHeight(0.9, false, view);
		expect(room(view) - h).toBe(ORCHESTRATOR_PANES_MIN);
	});
	it("is zero when collapsed or not measured yet, and never negative", () => {
		expect(topContentHeight(0.5, true, 1000)).toBe(0);
		expect(topContentHeight(0.5, false, 0)).toBe(0);
		expect(topContentHeight(0.5, false, 100)).toBe(0);
	});
	it("turns a dragged height back into the ratio", () => {
		const h = topContentHeight(0.4, false, 900);
		expect(ratioFor(h, 900)).toBeCloseTo(0.4, 2);
	});
	it("puts the panes under the strip, the content and the divider", () => {
		expect(panesTop(100)).toBe(
			ORCHESTRATOR_TAB_STRIP + 100 + ORCHESTRATOR_DIVIDER,
		);
	});
});

describe("the Peek explorer's width", () => {
	it("keeps a dragged width in range", () => {
		expect(clampPeekExplorerWidth(50)).toBe(PEEK_EXPLORER_MIN);
		expect(clampPeekExplorerWidth(9999)).toBe(PEEK_EXPLORER_MAX);
		expect(clampPeekExplorerWidth(300.4)).toBe(300);
		expect(clampPeekExplorerWidth(Number.NaN)).toBe(PEEK_EXPLORER_DEFAULT);
	});

	it("narrows it so the terminal keeps its room, and hides it when too narrow", () => {
		expect(peekExplorerShownWidth(220, 1000)).toBe(220);
		expect(peekExplorerShownWidth(400, PEEK_TERMINAL_MIN + 300)).toBe(300);
		expect(
			peekExplorerShownWidth(220, PEEK_TERMINAL_MIN + PEEK_EXPLORER_MIN - 1),
		).toBe(0);
		// Not measured yet: as asked.
		expect(peekExplorerShownWidth(220, 0)).toBe(220);
	});
});

describe("dragging the Peek explorer's edge", () => {
	it("never stores more than the column can show", () => {
		const column = PEEK_TERMINAL_MIN + 300;
		expect(peekExplorerDragWidth(470, column)).toBe(300);
		expect(peekExplorerDragWidth(250, column)).toBe(250);
		expect(peekExplorerDragWidth(10, column)).toBe(PEEK_EXPLORER_MIN);
		// Not measured yet: only kept in range.
		expect(peekExplorerDragWidth(9999, 0)).toBe(PEEK_EXPLORER_MAX);
	});
});
