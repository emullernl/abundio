/**
 * The **Chord**: one key pressed with zero or more modifiers. Pure helpers for
 * recording, spelling, comparing and vetting one, and for converting it to the
 * formats Monaco and the native menu expect. See the `Shortcut`, `Chord` and
 * `Override` entries in CONTEXT.md.
 *
 * How a key is stored follows the rule the built-in bindings already use:
 * letters and named keys (arrows, Enter, Tab, F1…) by `key`, the character
 * typed; digits and punctuation by `code`, the physical key. `key` breaks
 * Shift+digit chords (Shift+1 reports `!`); `code` would put letters in the
 * wrong place on AZERTY and Dvorak.
 */

export interface Chord {
	/** The character or named key. For a `code` chord it holds the US-layout
	 *  character, which is only used to spell the chord. */
	key: string;
	/** Match the physical key instead of `key`. See `KeyBinding.code`. */
	code?: string;
	meta: boolean;
	shift: boolean;
	ctrl: boolean;
	alt?: boolean;
}

/** Named keys stored by `key`. Space is stored by `code` (its `key` is " "). */
const NAMED_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Enter",
	"Tab",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	"Delete",
	"Backspace",
	"Insert",
	...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
]);

/** Physical keys stored by `code`, with the character they carry on a US
 *  layout (used to spell the chord and to compare it with a `key` chord). */
const CODE_CHARS: Record<string, string> = {
	Digit0: "0",
	Digit1: "1",
	Digit2: "2",
	Digit3: "3",
	Digit4: "4",
	Digit5: "5",
	Digit6: "6",
	Digit7: "7",
	Digit8: "8",
	Digit9: "9",
	Equal: "=",
	Minus: "-",
	BracketLeft: "[",
	BracketRight: "]",
	Semicolon: ";",
	Quote: "'",
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backquote: "`",
	Backslash: "\\",
	Space: " ",
};

const CHAR_CODES: Record<string, string> = Object.fromEntries(
	Object.entries(CODE_CHARS).map(([code, ch]) => [ch, code]),
);

const MODIFIER_KEYS = new Set([
	"Meta",
	"Control",
	"Shift",
	"Alt",
	"AltGraph",
	"CapsLock",
	"OS",
	"Fn",
	"Hyper",
	"Super",
]);

export function isModifierKey(key: string): boolean {
	return MODIFIER_KEYS.has(key);
}

/**
 * The chord a key press records, or null when it records nothing (a bare
 * modifier, or a key Abundio does not bind, such as a dead key).
 */
export function chordFromEvent(e: {
	key: string;
	code: string;
	metaKey: boolean;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}): Chord | null {
	if (isModifierKey(e.key)) return null;
	const mods = {
		meta: e.metaKey,
		shift: e.shiftKey,
		ctrl: e.ctrlKey,
		alt: e.altKey,
	};
	if (/^[a-z]$/i.test(e.key)) return { key: e.key.toLowerCase(), ...mods };
	// A letter key that typed something else: Option on macOS (Option+H is
	// "˙") or a non-Latin layout. Matching `key` would then never fire, so fall
	// back to the physical key.
	if (/^Key[A-Z]$/.test(e.code)) {
		return { key: e.code.slice(3).toLowerCase(), code: e.code, ...mods };
	}
	if (NAMED_KEYS.has(e.key)) return { key: e.key, ...mods };
	const ch = CODE_CHARS[e.code];
	if (ch !== undefined) return { key: ch, code: e.code, ...mods };
	return null;
}

/** An identity for the key half of a chord, so a `key: "="` default and a
 *  recorded `code: "Equal"` compare equal. */
function keyIdentity(c: Chord): string {
	if (c.code) return `code:${c.code}`;
	const viaCode = CHAR_CODES[c.key];
	if (viaCode) return `code:${viaCode}`;
	if (/^[a-z]$/i.test(c.key)) return `code:Key${c.key.toUpperCase()}`;
	return `key:${c.key}`;
}

export function chordsEqual(a: Chord, b: Chord): boolean {
	return (
		keyIdentity(a) === keyIdentity(b) &&
		a.meta === b.meta &&
		a.shift === b.shift &&
		a.ctrl === b.ctrl &&
		(a.alt ?? false) === (b.alt ?? false)
	);
}

/** Does this key press match the chord? Shared by the app keymap. */
export function eventMatchesChord(
	e: {
		key: string;
		code: string;
		metaKey: boolean;
		shiftKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
	},
	c: Chord,
): boolean {
	const keyMatches = c.code
		? e.code === c.code
		: e.key.toLowerCase() === c.key.toLowerCase();
	return (
		keyMatches &&
		e.metaKey === c.meta &&
		e.shiftKey === c.shift &&
		e.ctrlKey === c.ctrl &&
		e.altKey === (c.alt ?? false)
	);
}

const MAC_KEY_GLYPHS: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Enter: "↩",
	Tab: "⇥",
	Backspace: "⌫",
	Delete: "⌦",
	PageUp: "⇞",
	PageDown: "⇟",
	Home: "↖",
	End: "↘",
};

const OTHER_KEY_NAMES: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	PageUp: "PgUp",
	PageDown: "PgDn",
	Delete: "Del",
	Insert: "Ins",
};

function keyLabel(c: Chord, mac: boolean): string {
	if (c.code === "Space" || c.key === " ") return "Space";
	const named = (mac ? MAC_KEY_GLYPHS : OTHER_KEY_NAMES)[c.key];
	if (named) return named;
	if (c.code && CODE_CHARS[c.code] !== undefined) return CODE_CHARS[c.code];
	return c.key.length === 1 ? c.key.toUpperCase() : c.key;
}

/** Spell a chord: `⌃⌥⇧⌘G` on macOS, `Ctrl+Alt+Shift+G` elsewhere. */
export function formatChord(c: Chord, mac: boolean): string {
	const key = keyLabel(c, mac);
	if (mac) {
		return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.meta ? "⌘" : ""}${key}`;
	}
	const parts: string[] = [];
	if (c.ctrl) parts.push("Ctrl");
	if (c.alt) parts.push("Alt");
	if (c.shift) parts.push("Shift");
	if (c.meta) parts.push("Win");
	parts.push(key);
	return parts.join("+");
}

/** Chords the native menu owns outright. Recording one is refused: stealing
 *  Quit, Hide or the Edit menu's copy/paste would break the app itself.
 *  The Edit and Window menus are built on every platform (`build_menu`), and
 *  muda gives their items Ctrl accelerators on Windows/Linux too, so those
 *  are reserved everywhere — with Redo as Ctrl+Y there, Shift+⌘Z on macOS.
 *  Open settings is not here: its menu accelerator follows its Shortcut.
 *  Close Window (⌘W / Ctrl+W) is not here either, deliberately: it is Close
 *  tab's default, and the app's binding takes it before the menu does. */
export function reservedMenuChords(mac: boolean): Chord[] {
	const cmd = (key: string, extra: Partial<Chord> = {}): Chord => ({
		key,
		meta: mac,
		ctrl: !mac,
		shift: false,
		alt: false,
		...extra,
	});
	// Edit: undo, cut, copy, paste, select all. Window: minimize.
	const shared = [
		cmd("q"),
		cmd("z"),
		cmd("x"),
		cmd("c"),
		cmd("v"),
		cmd("a"),
		cmd("m"),
	];
	if (!mac) return [...shared, cmd("y")];
	return [
		...shared,
		cmd("z", { shift: true }),
		cmd("h"),
		cmd("h", { alt: true }),
		// View ▸ Enter Full Screen.
		cmd("f", { ctrl: true }),
	];
}

export type ChordVerdict =
	| { kind: "ok" }
	| { kind: "refuse"; reason: string }
	| { kind: "warn"; reason: string };

function isFunctionKey(c: Chord): boolean {
	return /^F\d{1,2}$/.test(c.key);
}

/** Whether a recorded chord may be saved, and what to warn about if so. */
export function chordVerdict(c: Chord, mac: boolean): ChordVerdict {
	if (isModifierKey(c.key)) {
		return { kind: "refuse", reason: "Press a key along with the modifiers." };
	}
	// Shift alone is not a modifier here: Shift+letter is how a capital is typed.
	if (!c.meta && !c.ctrl && !c.alt && !isFunctionKey(c)) {
		return {
			kind: "refuse",
			reason: mac
				? "Add ⌘, ⌃ or ⌥. Without one, this key is typing."
				: "Add Ctrl or Alt. Without one, this key is typing.",
		};
	}
	for (const reserved of reservedMenuChords(mac)) {
		if (chordsEqual(c, reserved)) {
			return {
				kind: "refuse",
				reason: `${formatChord(c, mac)} belongs to the app menu.`,
			};
		}
	}
	const alt = c.alt ?? false;
	if (!mac && c.ctrl && alt) {
		return {
			kind: "warn",
			reason:
				"Ctrl+Alt is AltGr on many European layouts, so this may swallow a character you type.",
		};
	}
	if (
		!mac &&
		c.ctrl &&
		!c.shift &&
		!c.meta &&
		!alt &&
		/^(code:Key[A-Z]|code:Digit\d)$/.test(keyIdentity(c))
	) {
		return {
			kind: "warn",
			reason: `${formatChord(c, mac)} is a terminal control code. With this, terminals never receive it.`,
		};
	}
	if (mac && alt && !c.meta && !c.ctrl) {
		return {
			kind: "warn",
			reason:
				"⌥ on its own types special characters, so this may swallow one you type.",
		};
	}
	return { kind: "ok" };
}

/** Reject anything that is not a well-formed chord. Stored overrides come from
 *  localStorage and other Windows, so they are read defensively. */
export function isChord(value: unknown): value is Chord {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.key === "string" &&
		v.key.length > 0 &&
		v.key.length <= 16 &&
		(v.code === undefined ||
			(typeof v.code === "string" && /^[A-Za-z0-9]{1,24}$/.test(v.code))) &&
		typeof v.meta === "boolean" &&
		typeof v.shift === "boolean" &&
		typeof v.ctrl === "boolean" &&
		(v.alt === undefined || typeof v.alt === "boolean")
	);
}

/** An Override id: `app:<KeyAction>` or `editor:<monaco action id>`. */
const OVERRIDE_ID = /^(app|editor):[A-Za-z0-9._\-/]{1,160}$/;

export type KeybindingOverrides = Record<string, Chord | null>;

/** Keep only well-formed entries: a known id shape mapped to a Chord or null
 *  (Unbound). Returns the input itself when nothing had to be dropped. */
export function sanitizeOverrides(raw: unknown): KeybindingOverrides {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: KeybindingOverrides = {};
	let dropped = false;
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (OVERRIDE_ID.test(id) && (value === null || isChord(value))) {
			out[id] = value;
		} else {
			dropped = true;
		}
	}
	return dropped ? out : (raw as KeybindingOverrides);
}

// ── Monaco ──────────────────────────────────────────────────────────────────

/** The subset of Monaco's `KeyMod` / `KeyCode` these helpers need. Passed in
 *  rather than imported: only the Monaco handed to `onMount` or returned by
 *  `loader.init()` is safe to use (see `conflictLenses.ts`). */
export interface MonacoKeys {
	KeyMod: { CtrlCmd: number; Shift: number; Alt: number; WinCtrl: number };
	KeyCode: Record<string, number | string>;
}

const MONACO_KEY_NAMES: Record<string, string> = {
	ArrowUp: "UpArrow",
	ArrowDown: "DownArrow",
	ArrowLeft: "LeftArrow",
	ArrowRight: "RightArrow",
};

function monacoKeyName(c: Chord): string {
	if (c.code) return c.code;
	const viaCode = CHAR_CODES[c.key];
	if (viaCode) return viaCode;
	if (/^[a-z]$/i.test(c.key)) return `Key${c.key.toUpperCase()}`;
	return MONACO_KEY_NAMES[c.key] ?? c.key;
}

/** A chord as a Monaco keybinding number, or null if Monaco has no such key.
 *  `CtrlCmd` is Cmd on macOS and Ctrl elsewhere; `WinCtrl` is the other one. */
export function toMonacoKeybinding(
	c: Chord,
	m: MonacoKeys,
	mac: boolean,
): number | null {
	const code = m.KeyCode[monacoKeyName(c)];
	if (typeof code !== "number") return null;
	let mods = 0;
	if (mac ? c.meta : c.ctrl) mods |= m.KeyMod.CtrlCmd;
	if (mac ? c.ctrl : c.meta) mods |= m.KeyMod.WinCtrl;
	if (c.shift) mods |= m.KeyMod.Shift;
	if (c.alt) mods |= m.KeyMod.Alt;
	return mods | code;
}

/** Monaco's `ResolvedChord` shape (`resolvedKeybinding.getChords()`). */
export interface MonacoResolvedChord {
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	keyLabel: string | null;
}

const FROM_MONACO_LABEL: Record<string, string> = {
	UpArrow: "ArrowUp",
	DownArrow: "ArrowDown",
	LeftArrow: "ArrowLeft",
	RightArrow: "ArrowRight",
	// On macOS Monaco labels the arrows with glyphs instead.
	"↑": "ArrowUp",
	"↓": "ArrowDown",
	"←": "ArrowLeft",
	"→": "ArrowRight",
	PageUp: "PageUp",
	PageDown: "PageDown",
	Home: "Home",
	End: "End",
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Delete: "Delete",
	Insert: "Insert",
	Escape: "Escape",
};

/** A chord from one of Monaco's resolved chords (its `keyLabel` is a
 *  `KeyCodeUtils` name: `K`, `UpArrow`, `=`, `F5`…), or null if unknown. */
export function fromMonacoChord(r: MonacoResolvedChord): Chord | null {
	const label = r.keyLabel;
	if (!label) return null;
	const mods = {
		meta: r.metaKey,
		shift: r.shiftKey,
		ctrl: r.ctrlKey,
		alt: r.altKey,
	};
	if (/^[A-Z]$/.test(label)) return { key: label.toLowerCase(), ...mods };
	if (label === "Space") return { key: " ", code: "Space", ...mods };
	const code = CHAR_CODES[label];
	if (code) return { key: label, code, ...mods };
	const named = FROM_MONACO_LABEL[label];
	if (named) return { key: named, ...mods };
	if (/^F\d{1,2}$/.test(label)) return { key: label, ...mods };
	return null;
}

// ── Native menu ─────────────────────────────────────────────────────────────

const ACCELERATOR_KEYS: Record<string, string> = {
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
};

/** A chord as a Tauri menu accelerator (`Cmd+Shift+Comma`). Keys are spelled
 *  as names, never punctuation, so the string stays alphanumeric plus `+`. */
export function toTauriAccelerator(c: Chord, mac: boolean): string | null {
	const parts: string[] = [];
	if (c.ctrl) parts.push("Ctrl");
	if (c.alt) parts.push("Alt");
	if (c.shift) parts.push("Shift");
	if (c.meta) parts.push(mac ? "Cmd" : "Super");
	let key: string;
	if (c.code) key = c.code;
	else if (CHAR_CODES[c.key]) key = CHAR_CODES[c.key];
	else if (/^[a-z]$/i.test(c.key)) key = c.key.toUpperCase();
	else if (ACCELERATOR_KEYS[c.key]) key = ACCELERATOR_KEYS[c.key];
	else if (NAMED_KEYS.has(c.key)) key = c.key;
	else return null;
	parts.push(key);
	return parts.join("+");
}

/** Whether the user set an Override for `id` (a Chord or Unbound). */
export function hasOverride(
	overrides: KeybindingOverrides,
	id: string,
): boolean {
	// `Object.hasOwn` is ES2022; this project's lib is ES2021.
	// biome-ignore lint/suspicious/noPrototypeBuiltins: see above
	return Object.prototype.hasOwnProperty.call(overrides, id);
}
