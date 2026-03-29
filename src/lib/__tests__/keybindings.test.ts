import { describe, it, expect, vi, afterEach } from "vitest";
import {
	registerAction,
	unregisterAction,
	handleKeyDown,
	initKeybindings,
} from "../keybindings";

function makeKeyEvent(opts: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
	return new KeyboardEvent("keydown", {
		key: opts.key,
		metaKey: opts.metaKey ?? false,
		shiftKey: opts.shiftKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
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

		const e = makeKeyEvent({ key: "h", [modKey]: true, shiftKey: true });
		handleKeyDown(e);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("unregistered handler is not called", () => {
		const handler = vi.fn();
		registerAction("split-horizontal", handler);
		unregisterAction("split-horizontal");

		const e = makeKeyEvent({ key: "h", [modKey]: true, shiftKey: true });
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
