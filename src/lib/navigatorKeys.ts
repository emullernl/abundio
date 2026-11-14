/**
 * **Navigator Shortcuts**: the Keymap actions that act only while the
 * Navigator is open and has the user's attention. Pure apart from the one
 * "is it live" predicate, which the Navigator sets on mount and clears on
 * unmount. `keybindings.ts` asks it to gate these actions, so the keys are
 * never claimed while the Navigator is closed, nor while another dialog sits
 * on top of it (New task, New workspace) and needs its own Tab.
 */
import { type Chord, formatChord } from "./chords";
import type { NavStatus } from "./navigatorTree";

export type NavigatorAction =
	| "navigator-toggle-scope"
	| "navigator-filter-waiting"
	| "navigator-filter-working"
	| "navigator-filter-ready"
	| "navigator-filter-idle"
	| "navigator-filter-error"
	| "navigator-filter-clear";

/** One action per status, in chip order. */
export const NAVIGATOR_STATUS_ACTIONS: Record<NavStatus, NavigatorAction> = {
	waiting: "navigator-filter-waiting",
	working: "navigator-filter-working",
	ready: "navigator-filter-ready",
	idle: "navigator-filter-idle",
	error: "navigator-filter-error",
};

export const NAVIGATOR_ACTIONS: readonly NavigatorAction[] = [
	"navigator-toggle-scope",
	...Object.values(NAVIGATOR_STATUS_ACTIONS),
	"navigator-filter-clear",
];

const NAVIGATOR_ACTION_SET: ReadonlySet<string> = new Set(NAVIGATOR_ACTIONS);

export function isNavigatorAction(action: string): action is NavigatorAction {
	return NAVIGATOR_ACTION_SET.has(action);
}

let livePredicate: (() => boolean) | null = null;

/** Set by the Navigator while it is mounted; null when it unmounts. */
export function setNavigatorKeysLive(isLive: (() => boolean) | null): void {
	livePredicate = isLive;
}

export function navigatorKeysLive(): boolean {
	return livePredicate?.() ?? false;
}

/** The Shift alias of the scope key: Shift + its Chord, or null when the
 *  Chord already has Shift (or is Unbound). */
export function scopeShiftAlias(chord: Chord | null): Chord | null {
	if (!chord || chord.shift) return null;
	return { ...chord, shift: true };
}

/** Override id of the scope key, whose Shift alias Settings also vets. */
export const SCOPE_OVERRIDE_ID = "app:navigator-toggle-scope";

export interface NavigatorHint {
	keys: string;
	label: string;
}

function sameModifiers(a: Chord, b: Chord): boolean {
	return (
		a.meta === b.meta &&
		a.shift === b.shift &&
		a.ctrl === b.ctrl &&
		(a.alt ?? false) === (b.alt ?? false)
	);
}

function digitOf(c: Chord): number | null {
	const m = /^Digit(\d)$/.exec(c.code ?? "");
	if (m) return Number(m[1]);
	return !c.code && /^\d$/.test(c.key) ? Number(c.key) : null;
}

/** The status keys as one range (`⌘1–5`) when every one is bound, they share
 *  modifiers, and they sit on consecutive digits in chip order. */
function statusRange(chords: readonly (Chord | null)[], mac: boolean) {
	if (chords.some((c) => !c)) return null;
	const all = chords as Chord[];
	const first = all[0];
	const start = digitOf(first);
	if (start === null) return null;
	for (let i = 0; i < all.length; i++) {
		if (!sameModifiers(all[i], first) || digitOf(all[i]) !== start + i) {
			return null;
		}
	}
	return `${formatChord(first, mac)}–${start + all.length - 1}`;
}

/** The Navigator's footer: its Shortcuts as they are bound now, then the
 *  fixed keys of the tree. */
export function navigatorHints(
	chordOf: (action: NavigatorAction) => Chord | null,
	statusLabels: Record<NavStatus, string>,
	mac: boolean,
): NavigatorHint[] {
	const out: NavigatorHint[] = [];
	const scope = chordOf("navigator-toggle-scope");
	if (scope) out.push({ keys: formatChord(scope, mac), label: "scope" });
	const statuses = Object.keys(NAVIGATOR_STATUS_ACTIONS) as NavStatus[];
	const chords = statuses.map((s) => chordOf(NAVIGATOR_STATUS_ACTIONS[s]));
	const range = statusRange(chords, mac);
	if (range) {
		out.push({ keys: range, label: "status" });
	} else {
		statuses.forEach((s, i) => {
			const c = chords[i];
			if (c) {
				out.push({
					keys: formatChord(c, mac),
					label: statusLabels[s].toLowerCase(),
				});
			}
		});
	}
	const clear = chordOf("navigator-filter-clear");
	if (clear) out.push({ keys: formatChord(clear, mac), label: "clear" });
	out.push(
		{ keys: "↑↓", label: "move" },
		{ keys: "←→", label: "fold" },
		{ keys: mac ? "↩" : "Enter", label: "go" },
		{ keys: "Esc", label: "close" },
	);
	return out;
}
