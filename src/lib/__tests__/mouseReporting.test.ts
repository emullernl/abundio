import { describe, expect, it } from "vitest";
import {
	hasTrackingMode,
	MOUSE_MODES_OFF_SEQUENCE,
	mouseBadgeStateFor,
	mouseModesIn,
	mouseModesOnSequence,
	mouseTransitionSequence,
	shouldSwallowDecset,
} from "../mouseReporting";

describe("mouseModesIn", () => {
	it("picks out the mouse modes and drops the rest", () => {
		expect(mouseModesIn([1049, 1002, 2004, 1006])).toEqual([1002, 1006]);
	});

	it("does not treat focus reporting as the mouse", () => {
		// 1004 fires on window focus, carries no coordinates, and TUIs use it to
		// redraw a cursor. Blocking it would break those redraws for no gain.
		expect(mouseModesIn([1004])).toEqual([]);
	});

	it("ignores sub-parameterised modes", () => {
		expect(mouseModesIn([[1002, 3]])).toEqual([]);
	});
});

describe("shouldSwallowDecset", () => {
	it("swallows a mouse-only DECSET while blocking", () => {
		expect(shouldSwallowDecset([1002], true)).toBe(true);
		expect(shouldSwallowDecset([1000, 1002, 1006], true)).toBe(true);
	});

	it("passes everything through when not blocking", () => {
		expect(shouldSwallowDecset([1002], false)).toBe(false);
	});

	it("never swallows a non-mouse DECSET", () => {
		expect(shouldSwallowDecset([1049], true)).toBe(false);
		expect(shouldSwallowDecset([2004], true)).toBe(false);
	});

	// The parser hook returns one boolean for the whole sequence, so a mixed set
	// is all-or-nothing. Failing OPEN means the program gets the mouse; failing
	// closed would drop the alternate-screen switch and leave a full-screen TUI
	// painting over the shell's scrollback. See ADR-0031.
	it("fails open on a mixed DECSET rather than dropping the other modes", () => {
		expect(shouldSwallowDecset([1049, 1002], true)).toBe(false);
	});

	it("ignores an empty parameter list", () => {
		expect(shouldSwallowDecset([], true)).toBe(false);
	});
});

describe("hasTrackingMode", () => {
	it("is true for a mode that actually turns reporting on", () => {
		expect(hasTrackingMode([1006, 1002])).toBe(true);
	});

	// A bare encoding request is not "asking for the mouse" in any sense the
	// user would recognise, so it raises no mouse badge.
	it("is false for encoding-only modes", () => {
		expect(hasTrackingMode([1006, 1015])).toBe(false);
	});

	it("is false for nothing at all", () => {
		expect(hasTrackingMode([])).toBe(false);
	});
});

describe("MOUSE_MODES_OFF_SEQUENCE", () => {
	it("turns every mouse mode off and touches nothing else", () => {
		expect(MOUSE_MODES_OFF_SEQUENCE).toBe(
			"\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l" +
				"\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l",
		);
		expect(MOUSE_MODES_OFF_SEQUENCE).not.toContain("1004");
	});
});

describe("mouseModesOnSequence", () => {
	// A program asks for the mouse exactly once. Without the replay, lifting the
	// block does nothing until that program is restarted.
	it("re-asserts what was refused", () => {
		expect(mouseModesOnSequence([1002, 1006])).toBe("\x1b[?1002h\x1b[?1006h");
	});

	it("orders tracking before encoding, however the set was built", () => {
		expect(mouseModesOnSequence(new Set([1006, 1002]))).toBe(
			"\x1b[?1002h\x1b[?1006h",
		);
	});

	it("refuses to replay anything that is not a mouse mode", () => {
		expect(mouseModesOnSequence([1049, 1002])).toBe("\x1b[?1002h");
	});

	it("is empty when nothing was refused", () => {
		expect(mouseModesOnSequence([])).toBe("");
	});
});

describe("mouseBadgeStateFor", () => {
	it("shows nothing when the program never asked", () => {
		expect(mouseBadgeStateFor("none", [])).toBe("none");
	});

	it("shows blocked when the program asked and xterm never got it", () => {
		expect(mouseBadgeStateFor("none", [1002, 1006])).toBe("blocked");
	});

	it("shows reporting when xterm is tracking", () => {
		expect(mouseBadgeStateFor("any", [1003])).toBe("reporting");
	});

	// The mixed-DECSET fail-open means a nominally blocking pane can still end
	// up reporting. The badge must tell the truth about that, not repeat our
	// intent — otherwise the one control that could fix it looks inapplicable.
	it("reports the truth when a mixed DECSET slipped past the block", () => {
		expect(mouseBadgeStateFor("drag", [1002])).toBe("reporting");
	});

	it("raises no badge for an encoding-only request", () => {
		expect(mouseBadgeStateFor("none", [1006])).toBe("none");
	});
});

describe("mouseTransitionSequence", () => {
	it("sweeps the mouse off when a pane starts blocking", () => {
		expect(mouseTransitionSequence(true, [1002])).toBe(
			MOUSE_MODES_OFF_SEQUENCE,
		);
	});

	it("replays what was refused when a pane stops blocking", () => {
		expect(mouseTransitionSequence(false, [1002, 1006])).toBe(
			"\x1b[?1002h\x1b[?1006h",
		);
	});

	// A pane nobody ever asked about needs no replay, so unblocking it writes
	// nothing at all rather than a stray no-op sequence.
	it("writes nothing when unblocking a pane that was never asked", () => {
		expect(mouseTransitionSequence(false, [])).toBe("");
	});

	// The sweep is unconditional by design: it also covers the pane whose mixed
	// DECSET slipped through, where `wanted` may not tell the whole story.
	it("sweeps even when nothing is recorded as wanted", () => {
		expect(mouseTransitionSequence(true, [])).toBe(MOUSE_MODES_OFF_SEQUENCE);
	});
});
