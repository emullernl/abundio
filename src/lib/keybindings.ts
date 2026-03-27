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
	| "new-session";

interface KeyBinding {
	key: string;
	meta: boolean;
	shift: boolean;
	ctrl: boolean;
	action: KeyAction;
}

const isMac = navigator.platform.toUpperCase().includes("MAC");

const DEFAULT_BINDINGS: KeyBinding[] = [
	{ key: "h", meta: isMac, shift: true, ctrl: !isMac, action: "split-horizontal" },
	{ key: "v", meta: isMac, shift: true, ctrl: !isMac, action: "split-vertical" },
	{ key: "w", meta: isMac, shift: true, ctrl: !isMac, action: "close-pane" },
	{ key: "ArrowUp", meta: isMac, shift: true, ctrl: !isMac, action: "navigate-up" },
	{ key: "ArrowDown", meta: isMac, shift: true, ctrl: !isMac, action: "navigate-down" },
	{ key: "ArrowLeft", meta: isMac, shift: true, ctrl: !isMac, action: "navigate-left" },
	{ key: "ArrowRight", meta: isMac, shift: true, ctrl: !isMac, action: "navigate-right" },
	{ key: "m", meta: isMac, shift: true, ctrl: !isMac, action: "maximize-pane" },
	{ key: "k", meta: isMac, shift: false, ctrl: !isMac, action: "command-palette" },
	{ key: "f", meta: isMac, shift: true, ctrl: !isMac, action: "search-in-terminal" },
	{ key: "n", meta: isMac, shift: true, ctrl: !isMac, action: "new-session" },
];

type ActionHandler = () => void;

const handlers = new Map<KeyAction, ActionHandler>();

export function registerAction(action: KeyAction, handler: ActionHandler) {
	handlers.set(action, handler);
}

export function unregisterAction(action: KeyAction) {
	handlers.delete(action);
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
			const handler = handlers.get(binding.action);
			if (handler) {
				e.preventDefault();
				e.stopPropagation();
				handler();
				return;
			}
		}
	}
}

export function initKeybindings() {
	// Use capture phase so we intercept before xterm.js handles the event
	window.addEventListener("keydown", handleKeyDown, true);
	return () => window.removeEventListener("keydown", handleKeyDown, true);
}
