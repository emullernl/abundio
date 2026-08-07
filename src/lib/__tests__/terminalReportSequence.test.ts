import { describe, expect, it } from "vitest";
import { isReportSequence } from "../terminalManager";

// `onData` gates ALL status bookkeeping behind this predicate: anything it
// calls a report is written straight to the PTY without touching the pane's
// status. Narrowing it (e.g. to mouse *clicks* only) would let mouse movement
// acknowledge an Error again — sweeping the pointer over a red pane turned it
// green, because an Agent TUI with mouse tracking on emits one of these per
// mouse move.
describe("isReportSequence", () => {
	it("catches SGR mouse reports, including motion", () => {
		expect(isReportSequence("\x1b[<0;10;5M")).toBe(true); // press
		expect(isReportSequence("\x1b[<0;10;5m")).toBe(true); // release
		expect(isReportSequence("\x1b[<35;10;5M")).toBe(true); // motion, no button
		expect(isReportSequence("\x1b[<32;10;5M")).toBe(true); // drag
		expect(isReportSequence("\x1b[<64;10;5M")).toBe(true); // wheel up
	});

	it("catches legacy X10 mouse and focus reports", () => {
		expect(isReportSequence("\x1b[M !!")).toBe(true);
		expect(isReportSequence("\x1b[I")).toBe(true);
		expect(isReportSequence("\x1b[O")).toBe(true);
	});

	it("lets real keystrokes through", () => {
		for (const key of ["a", "1", "\r", "\n", "\x1b", "\x1b[A", "\x03"]) {
			expect(isReportSequence(key)).toBe(false);
		}
	});
});
