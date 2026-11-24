import { describe, expect, it } from "vitest";
import {
	SHIFT_ENTER_SEQUENCE,
	type ShiftEnterKeyEvent,
	shiftEnterSequence,
} from "../shiftEnter";

const ev = (partial: Partial<ShiftEnterKeyEvent>): ShiftEnterKeyEvent => ({
	key: "Enter",
	shiftKey: true,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	...partial,
});

const normal = { alternateScreen: false, agentMode: false };

describe("shiftEnterSequence", () => {
	it("sends ESC + CR, the same as Option/Alt+Enter", () => {
		expect(SHIFT_ENTER_SEQUENCE).toBe("\x1b\r");
		expect(shiftEnterSequence(ev({}), normal)).toBe("\x1b\r");
	});

	it("applies on the normal screen whether or not an Agent runs", () => {
		expect(
			shiftEnterSequence(ev({}), { alternateScreen: false, agentMode: true }),
		).toBe("\x1b\r");
	});

	it("applies on the alternate screen only in agent mode", () => {
		expect(
			shiftEnterSequence(ev({}), { alternateScreen: true, agentMode: true }),
		).toBe("\x1b\r");
		expect(
			shiftEnterSequence(ev({}), { alternateScreen: true, agentMode: false }),
		).toBeNull();
	});

	it("leaves plain Enter to xterm", () => {
		expect(shiftEnterSequence(ev({ shiftKey: false }), normal)).toBeNull();
	});

	it("leaves Shift+Enter with another modifier alone", () => {
		expect(shiftEnterSequence(ev({ metaKey: true }), normal)).toBeNull();
		expect(shiftEnterSequence(ev({ ctrlKey: true }), normal)).toBeNull();
		expect(shiftEnterSequence(ev({ altKey: true }), normal)).toBeNull();
	});

	it("leaves an input method's composition alone", () => {
		expect(shiftEnterSequence(ev({ isComposing: true }), normal)).toBeNull();
	});

	it("ignores other keys", () => {
		expect(shiftEnterSequence(ev({ key: "a" }), normal)).toBeNull();
	});
});
