type KeyAction =
	| "split-horizontal"
	| "split-vertical"
	| "close-pane"
	| "navigate-up"
	| "navigate-down"
	| "navigate-left"
	| "navigate-right"
	| "maximize-pane"
	| "command-palette"
	| "search-in-terminal"
	| "new-session"
	| "new-tab"
	| "close-tab"
	| "next-tab"
	| "prev-tab"
	| "font-size-increase"
	| "font-size-decrease"
	| "save-file"
	| "toggle-git-panel"
	| "open-settings";

interface KeyBinding {
	key: string;
	meta: boolean;
	shift: boolean;
	ctrl: boolean;
	action: KeyAction;
}

import { isMac } from "./platform";

const DEFAULT_BINDINGS: KeyBinding[] = [
	{
		key: "h",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "split-horizontal",
	},
	{
		key: "v",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
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
	{ key: "m", meta: isMac, shift: true, ctrl: !isMac, action: "maximize-pane" },
	{
		key: "k",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "command-palette",
	},
	{
		key: "f",
		meta: isMac,
		shift: true,
		ctrl: !isMac,
		action: "search-in-terminal",
	},
	{ key: "n", meta: isMac, shift: true, ctrl: !isMac, action: "new-session" },
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
		action: "toggle-git-panel",
	},
	{
		key: ",",
		meta: isMac,
		shift: false,
		ctrl: !isMac,
		action: "open-settings",
	},
];

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
		e.ctrlKey === binding.ctrl
	);
}

export function handleKeyDown(e: KeyboardEvent) {
	for (const binding of DEFAULT_BINDINGS) {
		if (matchesBinding(e, binding)) {
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
