import { describe, expect, it } from "vitest";
import {
	altArrowWordJumpSequence,
	type WordJumpKeyEvent,
} from "../terminalWordJump";

const ev = (partial: Partial<WordJumpKeyEvent>): WordJumpKeyEvent => ({
	key: "",
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	...partial,
});

describe("altArrowWordJumpSequence", () => {
	it("maps Alt+ArrowLeft to ESC-b (backward-word)", () => {
		expect(
			altArrowWordJumpSequence(ev({ key: "ArrowLeft", altKey: true })),
		).toBe("\x1bb");
	});

	it("maps Alt+ArrowRight to ESC-f (forward-word)", () => {
		expect(
			altArrowWordJumpSequence(ev({ key: "ArrowRight", altKey: true })),
		).toBe("\x1bf");
	});

	it("returns null without Alt held", () => {
		expect(altArrowWordJumpSequence(ev({ key: "ArrowLeft" }))).toBeNull();
		expect(altArrowWordJumpSequence(ev({ key: "ArrowRight" }))).toBeNull();
	});

	it("defers to xterm when Alt is combined with Shift/Ctrl/Cmd", () => {
		expect(
			altArrowWordJumpSequence(
				ev({ key: "ArrowLeft", altKey: true, shiftKey: true }),
			),
		).toBeNull();
		expect(
			altArrowWordJumpSequence(
				ev({ key: "ArrowRight", altKey: true, ctrlKey: true }),
			),
		).toBeNull();
		expect(
			altArrowWordJumpSequence(
				ev({ key: "ArrowLeft", altKey: true, metaKey: true }),
			),
		).toBeNull();
	});

	it("swallows Alt+Up / Alt+Down silently (handled, sends nothing)", () => {
		expect(altArrowWordJumpSequence(ev({ key: "ArrowUp", altKey: true }))).toBe(
			"",
		);
		expect(
			altArrowWordJumpSequence(ev({ key: "ArrowDown", altKey: true })),
		).toBe("");
	});

	it("ignores other keys", () => {
		expect(altArrowWordJumpSequence(ev({ key: "b", altKey: true }))).toBeNull();
	});
});
