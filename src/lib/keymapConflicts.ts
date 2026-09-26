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
 */
import { type Chord, chordsEqual, chordVerdict } from "./chords";

export type KeymapScope = "app" | "editor";

export interface KeymapEntry {
	/** Override id: `app:<action>` or `editor:<monaco id>`. */
	id: string;
	label: string;
	scope: KeymapScope;
	/** The effective Chord; null when Unbound (or no default). */
	chord: Chord | null;
	/** App actions only: still fires while the editor has focus. */
	global?: boolean;
}

export type Conflict =
	| { kind: "same-scope"; other: KeymapEntry }
	| { kind: "cross-scope"; other: KeymapEntry };

export function findConflict(
	target: KeymapEntry,
	chord: Chord,
	entries: readonly KeymapEntry[],
): Conflict | null {
	let cross: KeymapEntry | null = null;
	for (const other of entries) {
		if (other.id === target.id || !other.chord) continue;
		if (!chordsEqual(other.chord, chord)) continue;
		if (other.scope === target.scope) return { kind: "same-scope", other };
		const appSide = target.scope === "app" ? target : other;
		if (appSide.global && !cross) cross = other;
	}
	return cross ? { kind: "cross-scope", other: cross } : null;
}

export type RecordingOutcome =
	| { kind: "refuse"; reason: string }
	/** Same-scope clash: ask Reassign or Cancel before writing anything. */
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
	const verdict = chordVerdict(chord, mac);
	if (verdict.kind === "refuse") return verdict;
	const warning = verdict.kind === "warn" ? verdict.reason : null;
	const conflict = findConflict(target, chord, entries);
	if (conflict?.kind === "same-scope") {
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
