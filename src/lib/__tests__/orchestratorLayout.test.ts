import { describe, expect, it } from "vitest";
import {
	clampPeekExplorerWidth,
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_PANES_MIN,
	ORCHESTRATOR_TAB_STRIP,
	PEEK_DIVIDER,
	PEEK_EXPLORER_DEFAULT,
	PEEK_EXPLORER_HANDLE,
	PEEK_EXPLORER_MAX,
	PEEK_EXPLORER_MIN,
	PEEK_LEFT_MIN,
	PEEK_TERMINAL_MIN,
	panesTop,
	peekExplorerDragWidth,
	peekLayout,
	peekTerminalWidthFor,
	ratioFor,
	topContentHeight,
} from "../orchestratorLayout";

describe("orchestratorLayout", () => {
	const room = (view: number) =>
		view - ORCHESTRATOR_TAB_STRIP - ORCHESTRATOR_DIVIDER;

	it("splits the room by the ratio", () => {
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
});

/** Every width the area holds adds back up to the area. */
const total = (l: { left: number; terminal: number; explorer: number }) =>
	l.left +
	PEEK_DIVIDER +
	l.terminal +
	(l.explorer > 0 ? PEEK_EXPLORER_HANDLE + l.explorer : 0);

describe("the Peek's layout", () => {
	const area = 1205; // room 1200 after the divider

	it("gives the terminal half the area before any drag", () => {
		const l = peekLayout({ area, terminalWidth: null, explorerWidth: null });
		expect(l).toEqual({ left: 600, terminal: 600, explorer: 0 });
	});

	it("keeps the dragged terminal width; the left side takes the rest", () => {
		const l = peekLayout({ area, terminalWidth: 500, explorerWidth: null });
		expect(l).toEqual({ left: 700, terminal: 500, explorer: 0 });
		expect(total(l)).toBe(area);
	});

	it("takes the explorer's room half from the terminal, half from the left", () => {
		const l = peekLayout({ area, terminalWidth: 500, explorerWidth: 200 });
		expect(l.explorer).toBe(200);
		expect(l.terminal).toBe(400);
		expect(l.left).toBe(1200 - PEEK_EXPLORER_HANDLE - 200 - 400);
		expect(total(l)).toBe(area);
	});

	it("lets the other side give the rest once one reaches its minimum", () => {
		const l = peekLayout({
			area,
			terminalWidth: PEEK_TERMINAL_MIN + 20,
			explorerWidth: 200,
		});
		expect(l.terminal).toBe(PEEK_TERMINAL_MIN);
		expect(total(l)).toBe(area);
		const wide = peekLayout({ area, terminalWidth: 900, explorerWidth: 200 });
		expect(wide.left).toBe(PEEK_LEFT_MIN);
		expect(total(wide)).toBe(area);
	});

	it("narrows the explorer, then hides it, when the area is too small", () => {
		const tight =
			PEEK_DIVIDER +
			PEEK_EXPLORER_HANDLE +
			PEEK_LEFT_MIN +
			PEEK_TERMINAL_MIN +
			PEEK_EXPLORER_MIN;
		const l = peekLayout({
			area: tight,
			terminalWidth: null,
			explorerWidth: 400,
		});
		expect(l).toEqual({
			left: PEEK_LEFT_MIN,
			terminal: PEEK_TERMINAL_MIN,
			explorer: PEEK_EXPLORER_MIN,
		});
		const none = peekLayout({
			area: tight - 1,
			terminalWidth: null,
			explorerWidth: 400,
		});
		expect(none.explorer).toBe(0);
		expect(total(none)).toBe(tight - 1);
	});

	it("halves an area too small for both minimums, and is empty unmeasured", () => {
		const l = peekLayout({ area: 305, terminalWidth: 900, explorerWidth: 200 });
		expect(l).toEqual({ left: 150, terminal: 150, explorer: 0 });
		expect(
			peekLayout({ area: 0, terminalWidth: null, explorerWidth: 200 }),
		).toEqual({ left: 0, terminal: 0, explorer: 0 });
	});
});

describe("dragging the divider beside the Peek", () => {
	const area = 1205;

	it("is the inverse of the layout, with or without the explorer", () => {
		const stored = peekTerminalWidthFor(700, area, 0);
		expect(stored).toBe(500);
		expect(
			peekLayout({ area, terminalWidth: stored, explorerWidth: null }).left,
		).toBe(700);

		const withExplorer = peekTerminalWidthFor(500, area, 200);
		const l = peekLayout({
			area,
			terminalWidth: withExplorer,
			explorerWidth: 200,
		});
		expect(l.left).toBe(500);
		// Hiding the explorer gives the terminal its half back.
		expect(withExplorer).toBe(l.terminal + 100);
	});

	it("gives back the terminal the user saw after a drag with a narrowed explorer", () => {
		// The explorer is drawn narrower than chosen only when both sides are
		// at their minimums, so a divider drag there cannot move anything.
		const narrow =
			PEEK_DIVIDER +
			PEEK_EXPLORER_HANDLE +
			PEEK_LEFT_MIN +
			PEEK_TERMINAL_MIN +
			200;
		const chosen = 300;
		const drawn = peekLayout({
			area: narrow,
			terminalWidth: null,
			explorerWidth: chosen,
		});
		expect(drawn).toEqual({
			left: PEEK_LEFT_MIN,
			terminal: PEEK_TERMINAL_MIN,
			explorer: 200,
		});
		for (const left of [0, PEEK_LEFT_MIN, 5000]) {
			const stored = peekTerminalWidthFor(left, narrow, drawn.explorer);
			expect(
				peekLayout({
					area: narrow,
					terminalWidth: stored,
					explorerWidth: chosen,
				}),
			).toEqual(drawn);
			// Wider again: the explorer grows back, and the terminal is still
			// the width the user saw.
			const wide = peekLayout({
				area: 2000,
				terminalWidth: stored,
				explorerWidth: chosen,
			});
			expect(wide.explorer).toBe(chosen);
			expect(wide.terminal).toBe(PEEK_TERMINAL_MIN);
		}
	});

	it("keeps both sides at their minimums", () => {
		expect(peekTerminalWidthFor(0, area, 0)).toBe(1200 - PEEK_LEFT_MIN);
		expect(peekTerminalWidthFor(5000, area, 0)).toBe(PEEK_TERMINAL_MIN);
	});
});

describe("dragging the Peek explorer's edge", () => {
	it("never stores more than the area can show", () => {
		const area =
			PEEK_DIVIDER +
			PEEK_EXPLORER_HANDLE +
			PEEK_LEFT_MIN +
			PEEK_TERMINAL_MIN +
			300;
		expect(peekExplorerDragWidth(470, area)).toBe(300);
		expect(peekExplorerDragWidth(250, area)).toBe(250);
		expect(peekExplorerDragWidth(10, area)).toBe(PEEK_EXPLORER_MIN);
		// Not measured yet: only kept in range.
		expect(peekExplorerDragWidth(9999, 0)).toBe(PEEK_EXPLORER_MAX);
	});
});
