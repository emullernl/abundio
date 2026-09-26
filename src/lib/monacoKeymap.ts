/**
 * Editor Shortcuts: Monaco's own actions, rebound through the same Overrides
 * as the app's (ids `editor:<monaco action id>`).
 *
 * Never import from `monaco-editor/esm/vs/...` here: `@monaco-editor/react`
 * fetches Monaco at runtime, and a deep import would bundle a second copy
 * whose keybinding service is not the one the editors use. Only the `Monaco`
 * handed to `onMount` or returned by `loader.init()` is safe (see
 * `conflictLenses.ts`).
 */
import type { Monaco } from "@monaco-editor/react";
import type { IDisposable } from "monaco-editor";
import {
	type Chord,
	fromMonacoChord,
	type KeybindingOverrides,
	type MonacoKeys,
	type MonacoResolvedChord,
	toMonacoKeybinding,
} from "./chords";
import { isMac } from "./platform";

export const EDITOR_PREFIX = "editor:";

export function editorOverrideId(actionId: string): string {
	return `${EDITOR_PREFIX}${actionId}`;
}

export interface KeybindingRule {
	keybinding: number;
	command: string;
}

/**
 * The rules that apply the editor Overrides: for every overridden action, a
 * `-<id>` removal of all its defaults (keybinding 0 matches every chord), then
 * the new chord unless it is Unbound. A Monaco action with several default
 * chords therefore ends up with exactly one, or none.
 */
export function buildMonacoRules(
	overrides: KeybindingOverrides,
	m: MonacoKeys,
	mac: boolean,
): KeybindingRule[] {
	const rules: KeybindingRule[] = [];
	for (const [id, chord] of Object.entries(overrides)) {
		if (!id.startsWith(EDITOR_PREFIX)) continue;
		const command = id.slice(EDITOR_PREFIX.length);
		rules.push({ keybinding: 0, command: `-${command}` });
		if (!chord) continue;
		const keybinding = toMonacoKeybinding(chord, m, mac);
		if (keybinding !== null) rules.push({ keybinding, command });
	}
	return rules;
}

// Monaco's keybinding rules are global to its instance, and there is one
// instance per Window, so they are applied once here rather than per editor.
let monaco: Monaco | null = null;
let overrides: KeybindingOverrides = {};
let applied: IDisposable | null = null;
const listeners = new Set<() => void>();

function reapply(): void {
	applied?.dispose();
	applied = null;
	if (!monaco) return;
	const rules = buildMonacoRules(
		overrides,
		monaco as unknown as MonacoKeys,
		isMac,
	);
	if (rules.length === 0) return;
	applied = monaco.editor.addKeybindingRules(rules) ?? null;
}

/** Called from every editor's `onMount`. The first call — Monaco loads lazily,
 *  on the first file opened — applies the Overrides already pushed. */
export function registerMonacoForKeymap(m: Monaco): void {
	if (monaco === m) return;
	monaco = m;
	reapply();
}

/** Called by `App.tsx` whenever the Overrides change. */
export function applyMonacoOverrides(next: KeybindingOverrides): void {
	overrides = next;
	reapply();
	for (const fn of listeners) fn();
}

/** Notified after each `applyMonacoOverrides`, so editor-local commands (the
 *  font-size forwards in `CodeEditor`) can follow the keymap. */
export function onMonacoOverridesChanged(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Test hook: forget the Monaco instance and any applied rules. */
export function resetMonacoKeymapForTests(): void {
	applied?.dispose();
	applied = null;
	monaco = null;
	overrides = {};
	listeners.clear();
}

// ── The catalogue (Settings window) ─────────────────────────────────────────

export interface EditorShortcut {
	id: string;
	label: string;
	/** The default as one Chord, or null when it has none or is a two-step
	 *  sequence (which Abundio cannot record). */
	defaultChord: Chord | null;
	/** Monaco's own spelling of the default, shown when it is a sequence. */
	defaultLabel: string | null;
}

interface ResolvedKeybindingLike {
	getLabel(): string | null;
	getChords(): MonacoResolvedChord[];
}

interface KeybindingServiceLike {
	lookupKeybinding(id: string): ResolvedKeybindingLike | undefined;
}

interface EditorLike {
	getSupportedActions(): { id: string; label: string }[];
	dispose(): void;
	_standaloneKeybindingService?: KeybindingServiceLike;
}

/** Actions Abundio adds to one editor (`abundio.*`), and per-editor ids Monaco
 *  scopes with a `:`, are not global commands a rule could rebind. */
function isRebindable(id: string): boolean {
	return !id.startsWith("abundio.") && !id.includes(":");
}

/** Read every labelled action and its default chord from a live editor. The
 *  default comes from the editor's keybinding service, an internal API, so
 *  it is guarded: without it every default reads as none. */
export function catalogueFromEditor(ed: EditorLike): EditorShortcut[] {
	const service = ed._standaloneKeybindingService;
	const out: EditorShortcut[] = [];
	const seen = new Set<string>();
	for (const action of ed.getSupportedActions()) {
		if (!action.label || !isRebindable(action.id) || seen.has(action.id)) {
			continue;
		}
		seen.add(action.id);
		let defaultChord: Chord | null = null;
		let defaultLabel: string | null = null;
		try {
			const kb = service?.lookupKeybinding(action.id);
			if (kb) {
				defaultLabel = kb.getLabel();
				const chords = kb.getChords();
				if (chords.length === 1) defaultChord = fromMonacoChord(chords[0]);
			}
		} catch {
			// Internal API changed shape: show the action without a default.
		}
		out.push({
			id: action.id,
			label: action.label,
			defaultChord,
			defaultLabel,
		});
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Load Monaco (from the CDN, as the editors do) and read its actions from an
 * offscreen throwaway editor. Rejects when Monaco cannot load, e.g. offline.
 */
export async function loadMonacoCatalogue(): Promise<EditorShortcut[]> {
	const { loader } = await import("@monaco-editor/react");
	const m = await loader.init();
	const host = document.createElement("div");
	host.style.cssText =
		"position:fixed;left:-10000px;top:0;width:400px;height:200px;visibility:hidden";
	document.body.appendChild(host);
	const ed = m.editor.create(host, { value: "" }) as unknown as EditorLike;
	try {
		return catalogueFromEditor(ed);
	} finally {
		ed.dispose();
		host.remove();
	}
}
