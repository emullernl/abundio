type KeyAction =
	| "split-horizontal"
	| "split-vertical"
	| "close-pane"
	| "navigate-up"
	| "navigate-down"
	| "navigate-left"
	| "navigate-right"
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
	| "paste";

interface KeyBinding {
	key: string;
	meta: boolean;
	shift: boolean;
	ctrl: boolean;
	// Defaults to false when omitted. Only the Linux/Windows split-vertical
	// binding sets this (Ctrl+Alt+V), freeing Ctrl+Shift+V for terminal paste.
	alt?: boolean;
	action: KeyAction;
}

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
	{ key: "]", meta: isMac, shift: true, ctrl: !isMac, action: "next-tab" },
	{ key: "[", meta: isMac, shift: true, ctrl: !isMac, action: "prev-tab" },
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
	return (
		e.key.toLowerCase() === binding.key.toLowerCase() &&
		e.metaKey === binding.meta &&
		e.shiftKey === binding.shift &&
		e.ctrlKey === binding.ctrl &&
		e.altKey === (binding.alt ?? false)
	);
}

export function handleKeyDown(e: KeyboardEvent) {
	for (const binding of DEFAULT_BINDINGS) {
		if (matchesBinding(e, binding)) {
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
