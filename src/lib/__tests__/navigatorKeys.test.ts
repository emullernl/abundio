import { describe, expect, it } from "vitest";
import type { Chord } from "../chords";
import {
	NAVIGATOR_STATUS_ACTIONS,
	type NavigatorAction,
	navigatorHints,
	scopeShiftAlias,
} from "../navigatorKeys";

const LABELS = {
	waiting: "Waiting",
	working: "Working",
	ready: "Ready",
	idle: "Idle",
	error: "Error",
};

const digit = (n: number, mods: Partial<Chord> = {}): Chord => ({
	key: String(n),
	code: `Digit${n}`,
	meta: true,
	shift: false,
	ctrl: false,
	...mods,
});

const tab: Chord = { key: "Tab", meta: false, shift: false, ctrl: false };

function defaults(): Map<NavigatorAction, Chord | null> {
	const m = new Map<NavigatorAction, Chord | null>();
	m.set("navigator-toggle-scope", tab);
	Object.values(NAVIGATOR_STATUS_ACTIONS).forEach((a, i) => {
		m.set(a, digit(i + 1));
	});
	m.set("navigator-filter-clear", digit(0));
	return m;
}

const hintsFor = (m: Map<NavigatorAction, Chord | null>, mac = true) =>
	navigatorHints((a) => m.get(a) ?? null, LABELS, mac).map(
		(h) => `${h.keys} ${h.label}`,
	);

describe("navigatorHints", () => {
	it("collapses consecutive status digits into a range", () => {
		expect(hintsFor(defaults())).toEqual([
			"⇥ scope",
			"⌘1–5 status",
			"⌘0 clear",
			"↑↓ move",
			"←→ fold",
			"↩ go",
			"Esc close",
		]);
	});

	it("spells the range with Windows/Linux modifiers", () => {
		const m = defaults();
		Object.values(NAVIGATOR_STATUS_ACTIONS).forEach((a, i) => {
			m.set(a, digit(i + 1, { meta: false, ctrl: true }));
		});
		expect(hintsFor(m, false)).toContain("Ctrl+1–5 status");
	});

	it("lists each status when one is rebound out of order", () => {
		const m = defaults();
		m.set("navigator-filter-ready", digit(9));
		const hints = hintsFor(m);
		expect(hints).toContain("⌘1 waiting");
		expect(hints).toContain("⌘9 ready");
		expect(hints.some((h) => h.includes("–"))).toBe(false);
	});

	it("leaves out Unbound keys and does not range over a gap", () => {
		const m = defaults();
		m.set("navigator-filter-idle", null);
		m.set("navigator-toggle-scope", null);
		const hints = hintsFor(m);
		expect(hints.some((h) => h.includes("idle"))).toBe(false);
		expect(hints.some((h) => h.includes("scope"))).toBe(false);
		expect(hints).toContain("⌘5 error");
	});

	it("does not range over mixed modifiers", () => {
		const m = defaults();
		m.set("navigator-filter-error", digit(5, { shift: true }));
		expect(hintsFor(m)).toContain("⇧⌘5 error");
	});
});

describe("scopeShiftAlias", () => {
	it("adds Shift to the scope key", () => {
		expect(scopeShiftAlias(tab)).toEqual({ ...tab, shift: true });
	});

	it("has none when the chord already has Shift, or is Unbound", () => {
		expect(scopeShiftAlias({ ...tab, shift: true })).toBeNull();
		expect(scopeShiftAlias(null)).toBeNull();
	});
});
