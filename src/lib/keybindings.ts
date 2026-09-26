export type KeyAction =
	| "split-horizontal"
	| "split-vertical"
	| "close-pane"
	| "navigate-up"
	| "navigate-down"
	| "navigate-left"
	| "navigate-right"
	| "next-pane"
	| "prev-pane"
	| "next-workspace"
	| "prev-workspace"
	| "add-worktree"
	| "command-palette"
	| "open-file-search"
	| "search-in-terminal"
	| "search-in-workspace"
	| "new-workspace"
	| "new-tab"
	| "new-task"
	| "close-tab"
	| "next-tab"
	| "prev-tab"
	| "font-size-increase"
	| "font-size-decrease"
	| "save-file"
	| "toggle-right-sidebar-git"
	| "toggle-right-sidebar-explorer"
	| "toggle-right-sidebar-notes"
	| "toggle-markdown-preview"
	| "toggle-statistics-overlay"
	| "toggle-fleet-console"
	| "fleet-spotlight"
	| "fleet-zoom-reset"
	| "open-settings"
	| "copy"
	| "paste"
	// Fires the Nth button in the focused pane's Action bar. The number is
	// **positional** — it names a slot in the bar, not a Prompt action.
	| "prompt-action-1"
	| "prompt-action-2"
	| "prompt-action-3"
	| "prompt-action-4"
	| "prompt-action-5"
	| "prompt-action-6"
	| "prompt-action-7"
	| "prompt-action-8"
	| "prompt-action-9";

/**
 * A built-in binding: a Chord plus the action it fires. The Chord fields are
 * documented on `Chord` in `chords.ts`; `code` matters most — see there and
 * the note below.
 *
 * `code` matches the **physical** key (`KeyboardEvent.code`) instead of `key`.
 * `key` carries the character produced, which is wrong for any binding on
 * the digit row. `Ctrl+Shift+1` reports `key: "!"`, so a binding written as
 * `key: "1"` never matches at all. Layout makes it worse in the other
 * direction: on AZERTY the unshifted `Digit1` key produces `"&"`, so even
 * the Shift-free `Cmd+1` would miss.
 *
 * `code` is the key's position on the board, so it is the same on every
 * layout and unaffected by Shift. `key` stays the default because for
 * letters it is the more forgiving match.
 *
 * `alt` defaults to false when omitted. Only the Linux/Windows split bindings
 * set it (Ctrl+Alt+H/V), freeing Ctrl+Shift+V for terminal paste.
 */
interface KeyBinding extends Chord {
	action: KeyAction;
}

import { hasOverlay } from "../hooks/useEscapeKey";
import {
	type Chord,
	eventMatchesChord,
	hasOverride,
	type KeybindingOverrides,
} from "./chords";
import { isMac } from "./platform";

// Actions that must always fire even when Monaco is focused — workspace/pane/tab
// management shortcuts that Monaco does not claim. Every other binding falls
// through to Monaco when the editor has focus, so Monaco's built-in shortcuts
// (Find, Replace, multi-cursor, line ops, Go to Definition, etc.) all work.
const WORKSPACE_GLOBAL_ACTIONS: Set<KeyAction> = new Set([
	"split-horizontal",
	"split-vertical",
	"close-pane",
	"navigate-up",
	"navigate-down",
	"navigate-left",
	"navigate-right",
	"next-pane",
	"prev-pane",
	"next-workspace",
	"prev-workspace",
	"add-worktree",
	"command-palette",
	"open-file-search",
	"search-in-workspace",
	"new-workspace",
	"new-tab",
	"new-task",
	"close-tab",
	"next-tab",
	"prev-tab",
	"toggle-right-sidebar-git",
	"toggle-right-sidebar-explorer",
	"toggle-right-sidebar-notes",
	"toggle-markdown-preview",
	"toggle-statistics-overlay",
	"toggle-fleet-console",
	"open-settings",
	"save-file",
]);

function isMonacoFocused(): boolean {
	const el = document.activeElement;
	return !!el && (el as Element).closest?.(".monaco-editor") !== null;
}

function isTerminalFocused(): boolean {
	const el = document.activeElement;
	return !!el && (el as Element).closest?.(".xterm") !== null;
}

// True when focus is in an editable element that is NOT a terminal. xterm.js
// receives input through a hidden <textarea> inside `.xterm`, which IS the
// paste target — so it must not count as "editable" here. Everything else
// (the workspace rename input, branch-selector search, the TipTap Notes editor,
// etc.) must NOT have terminal copy/paste hijack its keystrokes, or clipboard
// text would be written to a background terminal's PTY instead of the input.
function isEditableFocused(): boolean {
	const el = document.activeElement as HTMLElement | null;
	if (!el) return false;
	if (el.closest?.(".xterm")) return false;
	return (
		el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable
	);
}

const DEFAULT_BINDINGS: KeyBinding[] = [
	{
		// macOS: Cmd+Shift+H. Linux/Windows: Ctrl+Alt+H — kept symmetric with
		// split-vertical (Ctrl+Alt+V), which freed Ctrl+Shift+V for paste.
		key: "h",
		meta: isMac,
		shift: isMac,
		ctrl: !isMac,
		alt: !isMac,
		action: "split-horizontal",
	},
	{
		// macOS: Cmd+Shift+V. Linux/Windows: Ctrl+Alt+V — Ctrl+Shift+V is reserved
		// for terminal paste (the universal Linux convention), see below.
		key: "v",
		meta: isMac,
		shift: isMac,
		ctrl: !isMac,
		alt: !isMac,
		action: "split-vertical",
	},
	{ key: "w", meta: isMac, shift: true, ctrl: !isMac, action: "close-pane" },
	{
		key: "ArrowUp",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "navigate-up",
	},
	{
		key: "ArrowDown",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "navigate-down",
	},
	{
		key: "ArrowLeft",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "navigate-left",
	},
	{
		key: "ArrowRight",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "navigate-right",
	},
	// Workspace cycle. macOS: Ctrl+Cmd+Down / Up — vertical, like the Left
	// sidebar it walks. Not Cmd+Option: Monaco uses Cmd+Option+Up/Down to add a
	// cursor, and these are workspace-global, so they would take it over.
	// Monaco binds nothing to Ctrl+Cmd, and a Cmd chord never reaches the PTY.
	// Windows/Linux: Ctrl+Shift+PageDown / PageUp — the tab cycle plus Shift.
	// Not Ctrl+Alt+arrows, which GNOME takes for switching desktops (and
	// Ctrl+Alt is AltGr on European layouts).
	{
		key: isMac ? "ArrowDown" : "PageDown",
		meta: isMac,
		shift: !isMac,
		ctrl: true,
		action: "next-workspace",
	},
	{
		key: isMac ? "ArrowUp" : "PageUp",
		meta: isMac,
		shift: !isMac,
		ctrl: true,
		action: "prev-workspace",
	},
	// Pane cycle. macOS: Ctrl+Cmd+] / [ — not Cmd+Option, which is Monaco's
	// fold / unfold (see the workspace cycle above). Matched by `code`, like
	// every bracket binding. Windows/Linux:
	// Ctrl+Tab / Ctrl+Shift+Tab, since Ctrl+Alt is AltGr on European layouts
	// (and AltGr+bracket is how some of them type one). Terminals cannot tell
	// Ctrl+Tab from Tab, so taking it costs the PTY nothing.
	...(isMac
		? [
				{
					key: "]",
					code: "BracketRight",
					meta: true,
					shift: false,
					ctrl: true,
					action: "next-pane" as const,
				},
				{
					key: "[",
					code: "BracketLeft",
					meta: true,
					shift: false,
					ctrl: true,
					action: "prev-pane" as const,
				},
			]
		: [
				{
					key: "Tab",
					meta: false,
					shift: false,
					ctrl: true,
					action: "next-pane" as const,
				},
				{
					key: "Tab",
					meta: false,
					shift: true,
					ctrl: true,
					action: "prev-pane" as const,
				},
			]),
	{
		key: "k",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "command-palette",
	},
	{
		key: "p",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "open-file-search",
	},
	{
		key: "f",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "search-in-workspace",
	},
	{
		key: "f",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "search-in-terminal",
	},
	{ key: "n", meta: isMac, shift: true, ctrl: !isMac, action: "new-workspace" },
	// B for branch. Not Cmd+Option+N beside New workspace: its Windows/Linux
	// twin would be Ctrl+Alt+N, which is AltGr+N (ń on Polish layouts).
	{ key: "b", meta: isMac, shift: true, ctrl: !isMac, action: "add-worktree" },
	{ key: "t", meta: isMac, shift: false, ctrl: !isMac, action: "new-tab" },
	// T for task, beside New tab. Not muted in the Fleet Console: New task is
	// one of its own actions there.
	{ key: "t", meta: isMac, shift: true, ctrl: !isMac, action: "new-task" },
	{ key: "w", meta: isMac, shift: false, ctrl: !isMac, action: "close-tab" },
	// A note on the Windows/Linux chords below (tab, pane and workspace
	// cycles): unlike the macOS Cmd chords — and unlike the Prompt action
	// digits, which are chosen to be *invisible to the terminal* — these take
	// keys the PTY can see. xterm.js sends Ctrl+PageDown / PageUp as
	// `CSI 6;5~` / `CSI 5;5~` and Ctrl+Tab as a plain Tab, and programs such
	// as Midnight Commander, micro and Vim bind them. Being workspace-global and
	// captured first, they are withheld from every terminal. A deliberate
	// trade: every chord that stays invisible to the PTY on these platforms is
	// either taken by Monaco or is Ctrl+Alt, which is AltGr on European layouts.
	// (Shift+PageUp, xterm's scrollback paging, is unaffected.)
	// Tab cycle. macOS: Cmd+Shift+] / [, matched by position (`code`): with
	// Shift held, `key` reports `}` / `{` on US layouts and something else again
	// on others, so a `key: "]"` binding silently never fires.
	// Windows/Linux: Ctrl+PageDown / PageUp — the GNOME Terminal, Konsole,
	// VS Code and browser convention. Not Ctrl+Shift+] / [, which is Monaco's
	// fold / unfold there (these are workspace-global, so they would take it
	// over); Monaco scrolls with Alt+PageUp/Down on these platforms, leaving
	// Ctrl free.
	isMac
		? {
				key: "]",
				code: "BracketRight",
				meta: true,
				shift: true,
				ctrl: false,
				action: "next-tab",
			}
		: {
				key: "PageDown",
				meta: false,
				shift: false,
				ctrl: true,
				action: "next-tab",
			},
	isMac
		? {
				key: "[",
				code: "BracketLeft",
				meta: true,
				shift: true,
				ctrl: false,
				action: "prev-tab",
			}
		: {
				key: "PageUp",
				meta: false,
				shift: false,
				ctrl: true,
				action: "prev-tab",
			},
	{
		key: "=",
		// By position, like every punctuation binding: on German and French
		// layouts "=" needs Shift, so matching the character would miss.
		code: "Equal",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "font-size-increase",
	},
	{
		key: "-",
		// By position, like every punctuation binding: on German and French
		// layouts "=" needs Shift, so matching the character would miss.
		code: "Minus",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "font-size-decrease",
	},
	{ key: "s", meta: isMac, shift: false, ctrl: !isMac, action: "save-file" },
	{
		key: "g",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "toggle-right-sidebar-git",
	},
	{
		key: "e",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "toggle-right-sidebar-explorer",
	},
	{
		key: "k",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "toggle-right-sidebar-notes",
	},
	{
		key: "m",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "toggle-markdown-preview",
	},
	{
		key: "s",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "toggle-statistics-overlay",
	},
	{
		key: "a",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "toggle-fleet-console",
	},
	// Fleet Console only (gated in App): outside the console these keys reach
	// the terminal untouched.
	{
		key: "Enter",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "fleet-spotlight",
	},
	{
		key: "0",
		code: "Digit0",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "fleet-zoom-reset",
	},
	{
		key: ",",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "open-settings",
	},
];

// Terminal copy/paste keyboard shortcuts. macOS already copies/pastes via the
// native Cmd+C / Cmd+V (and globally grabbing those would break copy/paste in
// other panels), so these are Linux/Windows-only: Ctrl+Shift+C / Ctrl+Shift+V,
// the standard terminal-emulator bindings (plain Ctrl+C/Ctrl+V stay reserved
// for SIGINT / the shell). They are intentionally NOT workspace-global, so when
// Monaco has focus they fall through to the editor's own copy/paste.
if (!isMac) {
	DEFAULT_BINDINGS.push(
		{ key: "c", meta: false, shift: true, ctrl: true, action: "copy" },
		{ key: "v", meta: false, shift: true, ctrl: true, action: "paste" },
	);
}

// Action bar position numbers: Cmd+1..9 on macOS, Ctrl+Shift+1..9 elsewhere.
//
// The bindings are chosen to be *invisible to the terminal*, not merely unused
// by Abundio (which binds no digits at all). macOS `Cmd` is not a terminal
// modifier, so xterm.js never forwards a Cmd-chord to the PTY and no Agent can
// see it.
//
// On Linux/Windows `Ctrl+<digit>` is unusable — `Ctrl+2` is NUL, `Ctrl+3` is
// ESC, `Ctrl+4` is FS and so on across the row, all in constant use. And
// `Ctrl+Alt+<digit>` is unusable too, despite matching the split-pane
// precedent, because `Ctrl+Alt` **is AltGr** on European keyboard layouts and
// would swallow characters the user needs to type. That leaves Ctrl+Shift.
for (let n = 1; n <= 9; n++) {
	DEFAULT_BINDINGS.push({
		key: String(n),
		// Matched by position, not by character — see `KeyBinding.code`. Without
		// this the Windows/Linux chord cannot fire at all (Shift turns `1` into
		// `!`), and the macOS one misses on layouts where the digit row is
		// shifted, such as AZERTY.
		code: `Digit${n}`,
		meta: isMac,
		shift: !isMac,
		ctrl: !isMac,
		action: `prompt-action-${n}` as KeyAction,
	});
}

export type ShortcutCategory =
	| "Panes"
	| "Tabs"
	| "Workspaces"
	| "Panels"
	| "Fleet Console"
	| "Terminal"
	| "Files"
	| "App"
	| "Prompt actions";

export interface ActionMeta {
	label: string;
	category: ShortcutCategory;
}

/** Label and category of every app action, for Settings ▸ Keyboard. */
export const ACTION_META: Record<KeyAction, ActionMeta> = {
	"split-vertical": { label: "Split right", category: "Panes" },
	"split-horizontal": { label: "Split down", category: "Panes" },
	"close-pane": { label: "Close pane", category: "Panes" },
	"navigate-up": { label: "Focus pane above", category: "Panes" },
	"navigate-down": { label: "Focus pane below", category: "Panes" },
	"navigate-left": { label: "Focus pane to the left", category: "Panes" },
	"navigate-right": { label: "Focus pane to the right", category: "Panes" },
	"next-pane": { label: "Next pane", category: "Panes" },
	"prev-pane": { label: "Previous pane", category: "Panes" },
	"new-tab": { label: "New tab", category: "Tabs" },
	"new-task": { label: "New task", category: "Tabs" },
	"close-tab": { label: "Close tab", category: "Tabs" },
	"next-tab": { label: "Next tab", category: "Tabs" },
	"prev-tab": { label: "Previous tab", category: "Tabs" },
	"new-workspace": { label: "New workspace", category: "Workspaces" },
	"add-worktree": { label: "Add worktree", category: "Workspaces" },
	"next-workspace": {
		label: "Next opened workspace",
		category: "Workspaces",
	},
	"prev-workspace": {
		label: "Previous opened workspace",
		category: "Workspaces",
	},
	"toggle-right-sidebar-git": { label: "Toggle git panel", category: "Panels" },
	"toggle-right-sidebar-explorer": {
		label: "Toggle explorer panel",
		category: "Panels",
	},
	"search-in-workspace": { label: "Search workspace", category: "Panels" },
	"toggle-right-sidebar-notes": {
		label: "Toggle notes panel",
		category: "Panels",
	},
	"toggle-statistics-overlay": {
		label: "Toggle statistics",
		category: "Panels",
	},
	"toggle-fleet-console": {
		label: "Toggle Fleet Console",
		category: "Fleet Console",
	},
	"fleet-spotlight": {
		label: "Spotlight tile / back to grid",
		category: "Fleet Console",
	},
	"fleet-zoom-reset": {
		label: "Reset tile zoom",
		category: "Fleet Console",
	},
	"search-in-terminal": { label: "Find in terminal", category: "Terminal" },
	copy: { label: "Copy (terminal)", category: "Terminal" },
	paste: { label: "Paste (terminal)", category: "Terminal" },
	"font-size-increase": { label: "Increase font size", category: "Terminal" },
	"font-size-decrease": { label: "Decrease font size", category: "Terminal" },
	"open-file-search": { label: "Quick open file", category: "Files" },
	"save-file": { label: "Save file", category: "Files" },
	"toggle-markdown-preview": {
		label: "Toggle markdown preview",
		category: "Files",
	},
	"command-palette": { label: "Command palette", category: "App" },
	"open-settings": { label: "Open settings", category: "App" },
	"prompt-action-1": {
		label: "Fire prompt action 1",
		category: "Prompt actions",
	},
	"prompt-action-2": {
		label: "Fire prompt action 2",
		category: "Prompt actions",
	},
	"prompt-action-3": {
		label: "Fire prompt action 3",
		category: "Prompt actions",
	},
	"prompt-action-4": {
		label: "Fire prompt action 4",
		category: "Prompt actions",
	},
	"prompt-action-5": {
		label: "Fire prompt action 5",
		category: "Prompt actions",
	},
	"prompt-action-6": {
		label: "Fire prompt action 6",
		category: "Prompt actions",
	},
	"prompt-action-7": {
		label: "Fire prompt action 7",
		category: "Prompt actions",
	},
	"prompt-action-8": {
		label: "Fire prompt action 8",
		category: "Prompt actions",
	},
	"prompt-action-9": {
		label: "Fire prompt action 9",
		category: "Prompt actions",
	},
};

/** The actions that exist on this platform, in `DEFAULT_BINDINGS` order.
 *  Copy/paste are absent on macOS, which uses the native Cmd+C / Cmd+V. */
export const APP_ACTIONS: readonly KeyAction[] = DEFAULT_BINDINGS.map(
	(b) => b.action,
);

export function isWorkspaceGlobal(action: KeyAction): boolean {
	return WORKSPACE_GLOBAL_ACTIONS.has(action);
}

/** The Override id of an app action. Editor actions use `editor:<id>`. */
export function appOverrideId(action: KeyAction): string {
	return `app:${action}`;
}

function stripAction({ action: _a, ...chord }: KeyBinding): Chord {
	return chord;
}

/** The built-in Chord of an action on this platform, or null if it has none. */
export function defaultChord(action: KeyAction): Chord | null {
	const b = DEFAULT_BINDINGS.find((x) => x.action === action);
	return b ? stripAction(b) : null;
}

/** The Chord an action fires on: its Override if there is one (null when
 *  Unbound), else its default. Pure, so labels can compute it from the
 *  store's overrides in any Window. */
export function effectiveChord(
	action: KeyAction,
	overrides: KeybindingOverrides,
): Chord | null {
	const id = appOverrideId(action);
	if (hasOverride(overrides, id)) return overrides[id];
	return defaultChord(action);
}

/** The defaults with the Overrides applied: an Unbound action drops out, a
 *  rebound one keeps its place in the list with the new Chord. */
export function effectiveBindings(
	overrides: KeybindingOverrides,
): KeyBinding[] {
	const out: KeyBinding[] = [];
	for (const b of DEFAULT_BINDINGS) {
		const chord = effectiveChord(b.action, overrides);
		if (chord) out.push({ ...chord, action: b.action });
	}
	return out;
}

// The keymap `handleKeyDown` walks. Pushed in by `App.tsx` from the settings
// store — this module must not import the store (no module-graph cycles; same
// spirit as `terminalSettingsBridge`).
let activeBindings: KeyBinding[] = DEFAULT_BINDINGS;
let activeOverrides: KeybindingOverrides = {};

export function setKeybindingOverrides(overrides: KeybindingOverrides): void {
	activeOverrides = overrides;
	activeBindings = effectiveBindings(overrides);
}

/** The Chord an action currently fires on in this Window. */
export function getEffectiveChord(action: KeyAction): Chord | null {
	return effectiveChord(action, activeOverrides);
}

type ActionHandler = () => void;

const handlers = new Map<KeyAction, ActionHandler>();

// An action whose binding applies only in some state. While its gate says no,
// the key is not claimed at all: no preventDefault, so it reaches the
// terminal as if Abundio had no binding for it.
const gates = new Map<KeyAction, () => boolean>();

export function registerActionGate(
	action: KeyAction,
	isActive: () => boolean,
): void {
	gates.set(action, isActive);
}

export function registerAction(action: KeyAction, handler: ActionHandler) {
	handlers.set(action, handler);
}

export function unregisterAction(action: KeyAction) {
	handlers.delete(action);
}

export function triggerAction(action: KeyAction) {
	handlers.get(action)?.();
}

/** Actions that must not reach *past* an open modal.
 *
 *  Firing a Prompt action submits to the Agent, so a digit pressed while a
 *  dialog has the user's attention would send a prompt they never confirmed —
 *  from behind the thing they are looking at. For a parameterised action the
 *  open dialog merely swaps; for a parameterless one it goes straight out.
 *
 *  Terminal paste (Ctrl+Shift+V, Linux/Windows) is the same shape: with focus
 *  on a dialog's button rather than a text input, it would write the clipboard
 *  into the terminal behind the dialog. A text input inside the dialog is
 *  unaffected — the key falls through to its native paste either way. */
function isSuppressedByOverlay(action: KeyAction): boolean {
	return action === "paste" || action.startsWith("prompt-action-");
}

export function handleKeyDown(e: KeyboardEvent) {
	for (const binding of activeBindings) {
		if (eventMatchesChord(e, binding)) {
			if (isSuppressedByOverlay(binding.action) && hasOverlay()) return;
			// A closed gate means this binding does not claim the key right now:
			// move on, so it never shadows a later binding on the same chord.
			const gate = gates.get(binding.action);
			if (gate && !gate()) continue;
			// When Monaco is focused, let it handle any key that isn't a
			// workspace-global shortcut so its built-in bindings (Find, Replace,
			// multi-cursor, line ops, etc.) work.
			if (isMonacoFocused() && !WORKSPACE_GLOBAL_ACTIONS.has(binding.action)) {
				return;
			}
			// Let terminals receive Ctrl/Cmd+S directly. Agent CLIs use it for
			// inline editors and prompts (for example when adding MCP servers), and
			// intercepting it here prevents the PTY from ever seeing the keystroke.
			if (binding.action === "save-file" && isTerminalFocused()) {
				return;
			}
			// Terminal copy/paste must defer to a focused non-terminal text input
			// (rename field, branch search, Notes editor) — otherwise the
			// clipboard would be written to a background terminal's PTY.
			if (
				(binding.action === "copy" || binding.action === "paste") &&
				isEditableFocused()
			) {
				return;
			}
			// Always prevent default for registered bindings, even if no handler yet
			e.preventDefault();
			e.stopPropagation();
			const handler = handlers.get(binding.action);
			if (handler) {
				handler();
			}
			return;
		}
	}
}

export function initKeybindings() {
	// Use capture phase so we intercept before xterm.js handles the event
	window.addEventListener("keydown", handleKeyDown, true);
	return () => window.removeEventListener("keydown", handleKeyDown, true);
}
