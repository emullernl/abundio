type KeyAction =
	| "split-horizontal"
	| "split-vertical"
	| "close-pane"
	| "navigate-up"
	| "navigate-down"
	| "navigate-left"
	| "navigate-right"
	| "next-pane"
	| "prev-pane"
	| "command-palette"
	| "open-file-search"
	| "search-in-terminal"
	| "search-in-workspace"
	| "new-workspace"
	| "new-tab"
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

interface KeyBinding {
	key: string;
	/**
	 * Match the **physical** key (`KeyboardEvent.code`) instead of `key`.
	 *
	 * `key` carries the character produced, which is wrong for any binding on
	 * the digit row. `Ctrl+Shift+1` reports `key: "!"`, so a binding written as
	 * `key: "1"` never matches at all. Layout makes it worse in the other
	 * direction: on AZERTY the unshifted `Digit1` key produces `"&"`, so even
	 * the Shift-free `Cmd+1` would miss.
	 *
	 * `code` is the key's position on the board, so it is the same on every
	 * layout and unaffected by Shift. `key` stays the default because for
	 * letters it is the more forgiving match.
	 */
	code?: string;
	meta: boolean;
	shift: boolean;
	ctrl: boolean;
	// Defaults to false when omitted. Only the Linux/Windows split-vertical
	// binding sets this (Ctrl+Alt+V), freeing Ctrl+Shift+V for terminal paste.
	alt?: boolean;
	action: KeyAction;
}

import { hasOverlay } from "../hooks/useEscapeKey";
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
	"command-palette",
	"open-file-search",
	"search-in-workspace",
	"new-workspace",
	"new-tab",
	"close-tab",
	"next-tab",
	"prev-tab",
	"toggle-right-sidebar-git",
	"toggle-right-sidebar-explorer",
	"toggle-right-sidebar-notes",
	"toggle-markdown-preview",
	"toggle-statistics-overlay",
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
	// Pane cycle. macOS: Cmd+Option+] / [ — one modifier away from the tab
	// cycle, matched by `code` because Option turns `]` into `'`. Windows/Linux:
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
					ctrl: false,
					alt: true,
					action: "next-pane" as const,
				},
				{
					key: "[",
					code: "BracketLeft",
					meta: true,
					shift: false,
					ctrl: false,
					alt: true,
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
	{ key: "t", meta: isMac, shift: false, ctrl: !isMac, action: "new-tab" },
	{ key: "w", meta: isMac, shift: false, ctrl: !isMac, action: "close-tab" },
	// Brackets match by position (`code`): with Shift held, `key` reports `}` /
	// `{` on US layouts and something else again on others, so a `key: "]"`
	// binding silently never fires.
	{
		key: "]",
		code: "BracketRight",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "next-tab",
	},
	{
		key: "[",
		code: "BracketLeft",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "prev-tab",
	},
	{
		key: "=",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "font-size-increase",
	},
	{
		key: "-",
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

type ActionHandler = () => void;

const handlers = new Map<KeyAction, ActionHandler>();

export function registerAction(action: KeyAction, handler: ActionHandler) {
	handlers.set(action, handler);
}

export function unregisterAction(action: KeyAction) {
	handlers.delete(action);
}

export function triggerAction(action: KeyAction) {
	handlers.get(action)?.();
}

function matchesBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
	const keyMatches = binding.code
		? e.code === binding.code
		: e.key.toLowerCase() === binding.key.toLowerCase();
	return (
		keyMatches &&
		e.metaKey === binding.meta &&
		e.shiftKey === binding.shift &&
		e.ctrlKey === binding.ctrl &&
		e.altKey === (binding.alt ?? false)
	);
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
	for (const binding of DEFAULT_BINDINGS) {
		if (matchesBinding(e, binding)) {
			if (isSuppressedByOverlay(binding.action) && hasOverlay()) return;
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
