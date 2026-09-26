import { describe, expect, it } from "vitest";
import {
	type Chord,
	chordFromEvent,
	chordsEqual,
	chordVerdict,
	formatChord,
	fromMonacoChord,
	type MonacoKeys,
	sanitizeOverrides,
	toMonacoKeybinding,
	toTauriAccelerator,
} from "../chords";

function ev(
	key: string,
	code: string,
	mods: Partial<{
		meta: boolean;
		shift: boolean;
		ctrl: boolean;
		alt: boolean;
	}> = {},
) {
	return {
		key,
		code,
		metaKey: mods.meta ?? false,
		shiftKey: mods.shift ?? false,
		ctrlKey: mods.ctrl ?? false,
		altKey: mods.alt ?? false,
	};
}

const chord = (key: string, extra: Partial<Chord> = {}): Chord => ({
	key,
	meta: false,
	shift: false,
	ctrl: false,
	alt: false,
	...extra,
});

describe("chordFromEvent", () => {
	it("stores a letter by the character typed", () => {
		// Dvorak: the key at KeyJ types "h" — the chord follows the letter.
		expect(
			chordFromEvent(ev("H", "KeyJ", { meta: true, shift: true })),
		).toEqual(chord("h", { meta: true, shift: true }));
	});

	it("stores a digit by position, whatever Shift turns it into", () => {
		expect(
			chordFromEvent(ev("!", "Digit1", { ctrl: true, shift: true })),
		).toEqual(chord("1", { code: "Digit1", ctrl: true, shift: true }));
	});

	it("stores AZERTY's & key as Digit1", () => {
		expect(chordFromEvent(ev("&", "Digit1", { meta: true }))?.code).toBe(
			"Digit1",
		);
	});

	it("falls back to the physical key when Option changed the letter", () => {
		expect(chordFromEvent(ev("˙", "KeyH", { alt: true, meta: true }))).toEqual(
			chord("h", { code: "KeyH", alt: true, meta: true }),
		);
	});

	it("keeps named keys by name", () => {
		expect(chordFromEvent(ev("ArrowUp", "ArrowUp", { ctrl: true }))?.key).toBe(
			"ArrowUp",
		);
		expect(chordFromEvent(ev("F5", "F5"))?.key).toBe("F5");
	});

	it("records nothing for a bare modifier or an unknown key", () => {
		expect(
			chordFromEvent(ev("Shift", "ShiftLeft", { shift: true })),
		).toBeNull();
		expect(chordFromEvent(ev("Dead", "IntlRo", { ctrl: true }))).toBeNull();
	});
});

describe("chordsEqual", () => {
	it("treats a key default and a recorded code as the same key", () => {
		expect(
			chordsEqual(
				chord("=", { meta: true }),
				chord("=", { code: "Equal", meta: true }),
			),
		).toBe(true);
		expect(chordsEqual(chord("h"), chord("h", { code: "KeyH" }))).toBe(true);
	});

	it("tells modifiers apart", () => {
		expect(
			chordsEqual(chord("h", { meta: true }), chord("h", { ctrl: true })),
		).toBe(false);
		expect(
			chordsEqual(chord("h"), {
				key: "h",
				meta: false,
				shift: false,
				ctrl: false,
			}),
		).toBe(true);
	});
});

describe("formatChord", () => {
	it("uses glyphs in macOS order", () => {
		expect(formatChord(chord("g", { meta: true, shift: true }), true)).toBe(
			"⇧⌘G",
		);
		expect(
			formatChord(chord("ArrowDown", { meta: true, ctrl: true }), true),
		).toBe("⌃⌘↓");
		expect(
			formatChord(chord("]", { code: "BracketRight", meta: true }), true),
		).toBe("⌘]");
	});

	it("spells words elsewhere", () => {
		expect(formatChord(chord("v", { ctrl: true, alt: true }), false)).toBe(
			"Ctrl+Alt+V",
		);
		expect(
			formatChord(chord("PageDown", { ctrl: true, shift: true }), false),
		).toBe("Ctrl+Shift+PgDn");
		expect(
			formatChord(
				chord("1", { code: "Digit1", ctrl: true, shift: true }),
				false,
			),
		).toBe("Ctrl+Shift+1");
	});
});

describe("chordVerdict", () => {
	it("refuses a key with no real modifier", () => {
		expect(chordVerdict(chord("g"), true).kind).toBe("refuse");
		expect(chordVerdict(chord("g", { shift: true }), false).kind).toBe(
			"refuse",
		);
	});

	it("allows a bare function key", () => {
		expect(chordVerdict(chord("F5"), true).kind).toBe("ok");
	});

	it("refuses chords the menu owns", () => {
		expect(chordVerdict(chord("q", { meta: true }), true).kind).toBe("refuse");
		expect(chordVerdict(chord("c", { meta: true }), true).kind).toBe("refuse");
		expect(chordVerdict(chord("h", { meta: true, alt: true }), true).kind).toBe(
			"refuse",
		);
		expect(chordVerdict(chord("q", { ctrl: true }), false).kind).toBe("refuse");
	});

	it("warns about terminal control codes on Windows/Linux", () => {
		const v = chordVerdict(chord("c", { ctrl: true }), false);
		expect(v.kind).toBe("warn");
		expect(v.kind === "warn" && v.reason).toMatch(/interrupt/);
		expect(
			chordVerdict(chord("1", { code: "Digit1", ctrl: true }), false).kind,
		).toBe("warn");
		expect(
			chordVerdict(chord("c", { ctrl: true, shift: true }), false).kind,
		).toBe("ok");
	});

	it("warns about Ctrl+Alt (AltGr) on Windows/Linux only", () => {
		expect(
			chordVerdict(chord("n", { ctrl: true, alt: true }), false).kind,
		).toBe("warn");
		expect(chordVerdict(chord("n", { ctrl: true, alt: true }), true).kind).toBe(
			"ok",
		);
	});

	it("warns about Option-only chords on macOS", () => {
		expect(chordVerdict(chord("n", { alt: true }), true).kind).toBe("warn");
	});

	it("accepts an ordinary chord", () => {
		expect(
			chordVerdict(chord("g", { meta: true, shift: true }), true).kind,
		).toBe("ok");
	});
});

const monaco: MonacoKeys = {
	KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
	KeyCode: { KeyK: 41, Equal: 86, UpArrow: 16, Digit1: 22, F5: 63 },
};

describe("Monaco conversion", () => {
	it("maps Cmd to CtrlCmd on macOS and Ctrl to WinCtrl", () => {
		expect(
			toMonacoKeybinding(chord("k", { meta: true, shift: true }), monaco, true),
		).toBe(2048 | 1024 | 41);
		expect(toMonacoKeybinding(chord("k", { ctrl: true }), monaco, true)).toBe(
			256 | 41,
		);
	});

	it("maps Ctrl to CtrlCmd elsewhere", () => {
		expect(
			toMonacoKeybinding(chord("k", { ctrl: true, alt: true }), monaco, false),
		).toBe(2048 | 512 | 41);
	});

	it("knows punctuation, arrows and digits", () => {
		expect(toMonacoKeybinding(chord("=", { meta: true }), monaco, true)).toBe(
			2048 | 86,
		);
		expect(
			toMonacoKeybinding(chord("ArrowUp", { meta: true }), monaco, true),
		).toBe(2048 | 16);
		expect(
			toMonacoKeybinding(
				chord("1", { code: "Digit1", meta: true }),
				monaco,
				true,
			),
		).toBe(2048 | 22);
	});

	it("returns null for a key Monaco lacks", () => {
		expect(
			toMonacoKeybinding(chord("Insert", { meta: true }), monaco, true),
		).toBeNull();
	});

	it("reads Monaco's resolved chords back", () => {
		const r = { ctrlKey: false, shiftKey: true, altKey: false, metaKey: true };
		expect(fromMonacoChord({ ...r, keyLabel: "K" })).toEqual(
			chord("k", { meta: true, shift: true }),
		);
		expect(fromMonacoChord({ ...r, keyLabel: "UpArrow" })?.key).toBe("ArrowUp");
		expect(fromMonacoChord({ ...r, keyLabel: "=" })?.code).toBe("Equal");
		expect(fromMonacoChord({ ...r, keyLabel: "F5" })?.key).toBe("F5");
		expect(fromMonacoChord({ ...r, keyLabel: "OEM_8" })).toBeNull();
	});

	it("round-trips a chord through Monaco's shapes", () => {
		const c = chord("k", { meta: true, alt: true });
		const back = fromMonacoChord({
			ctrlKey: false,
			shiftKey: false,
			altKey: true,
			metaKey: true,
			keyLabel: "K",
		});
		expect(back && chordsEqual(back, c)).toBe(true);
	});
});

describe("toTauriAccelerator", () => {
	it("spells keys as names, never punctuation", () => {
		expect(toTauriAccelerator(chord(",", { meta: true }), true)).toBe(
			"Cmd+Comma",
		);
		expect(
			toTauriAccelerator(chord("k", { ctrl: true, shift: true }), false),
		).toBe("Ctrl+Shift+K");
		expect(
			toTauriAccelerator(chord("ArrowUp", { meta: true, alt: true }), true),
		).toBe("Alt+Cmd+Up");
		expect(
			toTauriAccelerator(chord("1", { code: "Digit1", meta: true }), true),
		).toBe("Cmd+Digit1");
	});
});

describe("sanitizeOverrides", () => {
	it("keeps good entries and drops malformed ones", () => {
		const good = chord("k", { meta: true });
		expect(
			sanitizeOverrides({
				"app:new-tab": good,
				"editor:editor.action.commentLine": null,
				"bogus id": good,
				"app:x": { key: 5 },
				"app:y": "Cmd+K",
			}),
		).toEqual({
			"app:new-tab": good,
			"editor:editor.action.commentLine": null,
		});
	});

	it("returns {} for anything that is not a plain object", () => {
		expect(sanitizeOverrides(null)).toEqual({});
		expect(sanitizeOverrides([1])).toEqual({});
		expect(sanitizeOverrides("x")).toEqual({});
	});
});

describe("fromMonacoChord on macOS", () => {
	it("reads the arrow glyphs Monaco uses there", () => {
		const r = { ctrlKey: false, shiftKey: false, altKey: true, metaKey: false };
		expect(fromMonacoChord({ ...r, keyLabel: "↑" })?.key).toBe("ArrowUp");
		expect(fromMonacoChord({ ...r, keyLabel: "↓" })?.key).toBe("ArrowDown");
		expect(fromMonacoChord({ ...r, keyLabel: "←" })?.key).toBe("ArrowLeft");
		expect(fromMonacoChord({ ...r, keyLabel: "→" })?.key).toBe("ArrowRight");
	});
});

describe("the default Open settings accelerator", () => {
	it("is spelled the way Rust seeds it, so launch does not rebuild the menu", () => {
		expect(
			toTauriAccelerator(
				{ key: ",", meta: true, shift: false, ctrl: false },
				true,
			),
		).toBe("Cmd+Comma");
		expect(
			toTauriAccelerator(
				{ key: ",", meta: false, shift: false, ctrl: true },
				false,
			),
		).toBe("Ctrl+Comma");
		expect(
			toTauriAccelerator(
				{ key: "F5", meta: false, shift: false, ctrl: false },
				true,
			),
		).toBe("F5");
	});
});
