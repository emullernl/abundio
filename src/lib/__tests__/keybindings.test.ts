import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleKeyDown,
	initKeybindings,
	registerAction,
	unregisterAction,
} from "../keybindings";

function makeKeyEvent(
	opts: Partial<KeyboardEvent> & { key: string },
): KeyboardEvent {
	return new KeyboardEvent("keydown", {
		key: opts.key,
		metaKey: opts.metaKey ?? false,
		shiftKey: opts.shiftKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
		altKey: opts.altKey ?? false,
		bubbles: true,
	});
}

// On macOS (jsdom navigator.platform defaults vary), bindings use meta+shift
// The keybindings module reads navigator.platform at module load time.
// In jsdom it defaults to "" which means isMac=false, so we use ctrl variants.
const isMac = navigator.platform.toUpperCase().includes("MAC");
const modKey = isMac ? "metaKey" : "ctrlKey";

describe("registerAction / unregisterAction", () => {
	afterEach(() => {
		unregisterAction("split-horizontal");
		unregisterAction("new-tab");
	});

	it("registered handler is called on matching key event", () => {
		const handler = vi.fn();
		registerAction("split-horizontal", handler);

		const e = makeKeyEvent({
			key: "h",
			[modKey]: true,
			shiftKey: isMac,
			altKey: !isMac,
		});
		handleKeyDown(e);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("unregistered handler is not called", () => {
		const handler = vi.fn();
		registerAction("split-horizontal", handler);
		unregisterAction("split-horizontal");

		const e = makeKeyEvent({
			key: "h",
			[modKey]: true,
			shiftKey: isMac,
			altKey: !isMac,
		});
		handleKeyDown(e);
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("handleKeyDown", () => {
	afterEach(() => {
		unregisterAction("new-tab");
		unregisterAction("command-palette");
	});

	it("calls preventDefault and stopPropagation for matching binding", () => {
		registerAction("new-tab", vi.fn());
		const e = makeKeyEvent({ key: "t", [modKey]: true });

		const preventSpy = vi.spyOn(e, "preventDefault");
		const stopSpy = vi.spyOn(e, "stopPropagation");

		handleKeyDown(e);
		expect(preventSpy).toHaveBeenCalled();
		expect(stopSpy).toHaveBeenCalled();
	});

	it("still prevents default even without a handler", () => {
		// command-palette binding exists but no handler registered
		const e = makeKeyEvent({ key: "k", [modKey]: true });
		const preventSpy = vi.spyOn(e, "preventDefault");

		handleKeyDown(e);
		expect(preventSpy).toHaveBeenCalled();
	});

	it("does not intercept non-matching key events", () => {
		const e = makeKeyEvent({ key: "z", [modKey]: true });
		const preventSpy = vi.spyOn(e, "preventDefault");

		handleKeyDown(e);
		expect(preventSpy).not.toHaveBeenCalled();
	});
});

describe("Monaco focus delegation", () => {
	afterEach(() => {
		unregisterAction("save-file");
		document.body.innerHTML = "";
	});

	function focusMonaco(): void {
		const editor = document.createElement("div");
		editor.className = "monaco-editor";
		const input = document.createElement("textarea");
		editor.appendChild(input);
		document.body.appendChild(editor);
		input.focus();
	}

	it("fires save-file even when a Monaco editor is focused", () => {
		const handler = vi.fn();
		registerAction("save-file", handler);
		focusMonaco();

		const e = makeKeyEvent({ key: "s", [modKey]: true });
		handleKeyDown(e);

		expect(handler).toHaveBeenCalledOnce();
	});
});

// Terminal copy/paste are Linux/Windows-only bindings; the test env is non-mac,
// so they're active here. (The keybindings module's `isMac` comes from
// platform.ts, which falls back to `navigator.userAgent` — jsdom's UA starts
// with "Mozilla/5.0 (linux) …", so /Mac/i doesn't match.) On a real macOS
// runner these bindings are absent, so skip rather than assert.
describe("terminal copy/paste (Linux/Windows)", () => {
	afterEach(() => {
		unregisterAction("copy");
		unregisterAction("paste");
		unregisterAction("split-vertical");
		document.body.innerHTML = "";
	});

	function focus(tag: string, className?: string): void {
		const el = document.createElement(tag);
		if (className) el.className = className;
		document.body.appendChild(el);
		(el as HTMLElement).focus();
	}

	it.skipIf(isMac)("paste defers to a focused text input", () => {
		const paste = vi.fn();
		registerAction("paste", paste);
		focus("input");
		const e = makeKeyEvent({ key: "v", ctrlKey: true, shiftKey: true });
		const preventSpy = vi.spyOn(e, "preventDefault");
		handleKeyDown(e);
		expect(paste).not.toHaveBeenCalled();
		expect(preventSpy).not.toHaveBeenCalled(); // input keeps native handling
	});

	it.skipIf(isMac)("paste fires when xterm's own textarea is focused", () => {
		const paste = vi.fn();
		registerAction("paste", paste);
		// xterm's hidden input is a <textarea> inside `.xterm` — it IS the
		// paste target, so it must not be treated as an editable to defer to.
		const term = document.createElement("div");
		term.className = "xterm";
		const ta = document.createElement("textarea");
		term.appendChild(ta);
		document.body.appendChild(term);
		ta.focus();
		handleKeyDown(makeKeyEvent({ key: "v", ctrlKey: true, shiftKey: true }));
		expect(paste).toHaveBeenCalledOnce();
	});

	it.skipIf(isMac)("Ctrl+Shift+C triggers copy", () => {
		const handler = vi.fn();
		registerAction("copy", handler);
		handleKeyDown(makeKeyEvent({ key: "c", ctrlKey: true, shiftKey: true }));
		expect(handler).toHaveBeenCalledOnce();
	});

	it.skipIf(isMac)("Ctrl+Shift+V triggers paste, not split-vertical", () => {
		const paste = vi.fn();
		const split = vi.fn();
		registerAction("paste", paste);
		registerAction("split-vertical", split);
		handleKeyDown(makeKeyEvent({ key: "v", ctrlKey: true, shiftKey: true }));
		expect(paste).toHaveBeenCalledOnce();
		expect(split).not.toHaveBeenCalled();
	});

	it.skipIf(isMac)("Ctrl+Alt+V triggers split-vertical, not paste", () => {
		const paste = vi.fn();
		const split = vi.fn();
		registerAction("paste", paste);
		registerAction("split-vertical", split);
		handleKeyDown(makeKeyEvent({ key: "v", ctrlKey: true, altKey: true }));
		expect(split).toHaveBeenCalledOnce();
		expect(paste).not.toHaveBeenCalled();
	});
});

describe("initKeybindings", () => {
	it("returns a cleanup function that removes the listener", () => {
		const handler = vi.fn();
		registerAction("command-palette", handler);

		const cleanup = initKeybindings();

		window.dispatchEvent(makeKeyEvent({ key: "k", [modKey]: true }));
		expect(handler).toHaveBeenCalledOnce();

		cleanup();

		window.dispatchEvent(makeKeyEvent({ key: "k", [modKey]: true }));
		// Should not be called again after cleanup
		expect(handler).toHaveBeenCalledOnce();

		unregisterAction("command-palette");
	});
});
