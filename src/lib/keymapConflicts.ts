/**
 * Who else already uses a Chord. Pure, so Settings ▸ Keyboard can ask before
 * it writes an Override.
 *
 * Within one scope (app↔app, editor↔editor) a shared Chord silently kills one
 * of the two actions — `handleKeyDown` fires the first match — so it must be
 * resolved: Reassign (the other becomes Unbound) or Cancel. Across scopes a
 * shared Chord is allowed: a workspace-global app action and an editor action
 * on one Chord means the app wins while the editor has focus, which is worth a
 * warning but may well be what the user wants. A non-global app action falls
 * through to Monaco when the editor has focus, so it never clashes with one.
 *
 * A Navigator Shortcut acts only while the Navigator is open. It clashes with
 * another Navigator Shortcut and with an app Shortcut that still acts then;
 * one that stands down under the Navigator (a Prompt action) and every editor
 * Shortcut leave it alone.
 */
import { type Chord, chordsEqual, chordVerdict } from "./chords";

export type KeymapScope = "app" | "editor" | "navigator";

export interface KeymapEntry {
	/** Override id: `app:<action>` or `editor:<monaco id>`. */
	id: string;
	label: string;
	scope: KeymapScope;
	/** The effective Chord; null when Unbound (or no default). */
	chord: Chord | null;
	/** App actions only: still fires while the editor has focus. */
	global?: boolean;
	/** App actions only: does nothing while the Navigator is open. */
	standsDownUnderNavigator?: boolean;
}

export type Conflict =
	/** Both act on one key press: one would silently never fire. */
	| { kind: "clash"; other: KeymapEntry }
	/** App and editor share a Chord; the app wins while the editor has focus. */
	| { kind: "cross-scope"; other: KeymapEntry };

function relation(
	a: KeymapEntry,
	b: KeymapEntry,
): "clash" | "cross-scope" | null {
	if (a.scope === b.scope) return "clash";
	if (a.scope === "navigator" || b.scope === "navigator") {
		const other = a.scope === "navigator" ? b : a;
		if (other.scope === "editor") return null;
		return other.standsDownUnderNavigator ? null : "clash";
	}
	const appSide = a.scope === "app" ? a : b;
	return appSide.global ? "cross-scope" : null;
}

export function findConflict(
	target: KeymapEntry,
	chord: Chord,
	entries: readonly KeymapEntry[],
): Conflict | null {
	let cross: KeymapEntry | null = null;
	for (const other of entries) {
		if (other.id === target.id || !other.chord) continue;
		if (!chordsEqual(other.chord, chord)) continue;
		const rel = relation(target, other);
		if (rel === "clash") return { kind: "clash", other };
		if (rel === "cross-scope" && !cross) cross = other;
	}
	return cross ? { kind: "cross-scope", other: cross } : null;
}

export type RecordingOutcome =
	| { kind: "refuse"; reason: string }
	/** A clash: ask Reassign or Cancel before writing anything. */
	| { kind: "ask"; other: KeymapEntry; warning: string | null }
	/** Safe to write; `notice` is a warning to show beside the row. */
	| { kind: "commit"; notice: string | null };

/** What Settings ▸ Keyboard does with a freshly recorded Chord.
 *
 *  `entries` holds editor rows only once the Editor group's catalogue has
 *  loaded (it is fetched when that group is first opened). Until then an app
 *  rebind gets no cross-scope notice. That only drops a warning — the app
 *  still wins while the editor has focus either way — so it is left as is. */
export function planRecording(
	target: KeymapEntry,
	chord: Chord,
	entries: readonly KeymapEntry[],
	mac: boolean,
): RecordingOutcome {
	const verdict = chordVerdict(chord, mac, {
		navigator: target.scope === "navigator",
	});
	if (verdict.kind === "refuse") return verdict;
	const warning = verdict.kind === "warn" ? verdict.reason : null;
	const conflict = findConflict(target, chord, entries);
	if (conflict?.kind === "clash") {
		return { kind: "ask", other: conflict.other, warning };
	}
	if (conflict?.kind === "cross-scope") {
		const note =
			target.scope === "app"
				? `Also bound in the editor to “${conflict.other.label}”. This shortcut wins while the editor has focus.`
				: `Also bound to the app's “${conflict.other.label}”, which wins while the editor has focus.`;
		return { kind: "commit", notice: warning ? `${warning} ${note}` : note };
	}
	return { kind: "commit", notice: warning };
}
