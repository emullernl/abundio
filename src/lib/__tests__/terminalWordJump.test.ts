import { describe, expect, it } from "vitest";
import { modifiedNavKeySequence, type NavKeyEvent } from "../terminalWordJump";

const ev = (partial: Partial<NavKeyEvent>): NavKeyEvent => ({
	key: "",
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	...partial,
});

describe("modifiedNavKeySequence", () => {
	it("maps Alt+Left / Ctrl+Left to ESC-b (backward-word)", () => {
		expect(modifiedNavKeySequence(ev({ key: "ArrowLeft", altKey: true }))).toBe(
			"\x1bb",
		);
		expect(
			modifiedNavKeySequence(ev({ key: "ArrowLeft", ctrlKey: true })),
		).toBe("\x1bb");
	});

	it("maps Alt+Right / Ctrl+Right to ESC-f (forward-word)", () => {
		expect(
			modifiedNavKeySequence(ev({ key: "ArrowRight", altKey: true })),
		).toBe("\x1bf");
		expect(
			modifiedNavKeySequence(ev({ key: "ArrowRight", ctrlKey: true })),
		).toBe("\x1bf");
	});

	it("leaves unmodified nav keys to the shell (null)", () => {
		expect(modifiedNavKeySequence(ev({ key: "ArrowLeft" }))).toBeNull();
		expect(modifiedNavKeySequence(ev({ key: "Home" }))).toBeNull();
		expect(modifiedNavKeySequence(ev({ key: "Delete" }))).toBeNull();
	});

	it("never claims Cmd (meta) combos", () => {
		expect(
			modifiedNavKeySequence(ev({ key: "ArrowLeft", metaKey: true })),
		).toBeNull();
		expect(
			modifiedNavKeySequence(
				ev({ key: "ArrowLeft", altKey: true, metaKey: true }),
			),
		).toBeNull();
	});

	it("swallows vertical Alt/Ctrl arrows silently", () => {
		expect(modifiedNavKeySequence(ev({ key: "ArrowUp", altKey: true }))).toBe(
			"",
		);
		expect(modifiedNavKeySequence(ev({ key: "ArrowDown", altKey: true }))).toBe(
			"",
		);
		expect(modifiedNavKeySequence(ev({ key: "ArrowUp", ctrlKey: true }))).toBe(
			"",
		);
		expect(
			modifiedNavKeySequence(ev({ key: "ArrowDown", ctrlKey: true })),
		).toBe("");
	});

	it("swallows Shift+Arrow (no shell selection) silently", () => {
		for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			expect(modifiedNavKeySequence(ev({ key, shiftKey: true }))).toBe("");
		}
	});

	it("swallows word-jump arrows when Shift is also held", () => {
		expect(
			modifiedNavKeySequence(
				ev({ key: "ArrowLeft", ctrlKey: true, shiftKey: true }),
			),
		).toBe("");
		expect(
			modifiedNavKeySequence(
				ev({ key: "ArrowRight", altKey: true, shiftKey: true }),
			),
		).toBe("");
	});

	it("swallows modified Home/End/Delete/PageUp/PageDown silently", () => {
		for (const key of ["Home", "End", "Delete", "PageUp", "PageDown"]) {
			expect(modifiedNavKeySequence(ev({ key, altKey: true }))).toBe("");
			expect(modifiedNavKeySequence(ev({ key, ctrlKey: true }))).toBe("");
			expect(modifiedNavKeySequence(ev({ key, shiftKey: true }))).toBe("");
		}
	});

	it("ignores other keys", () => {
		expect(modifiedNavKeySequence(ev({ key: "b", altKey: true }))).toBeNull();
		expect(modifiedNavKeySequence(ev({ key: "a", ctrlKey: true }))).toBeNull();
	});
});
