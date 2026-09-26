import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/monacoKeymap", async (orig) => ({
	...(await orig<typeof import("../../../lib/monacoKeymap")>()),
	loadMonacoCatalogue: vi.fn(() => Promise.reject(new Error("offline"))),
}));

import { isMac } from "../../../lib/platform";
import { useSettingsStore } from "../../../stores/settingsStore";
import { KeyboardSection } from "../KeyboardSection";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	useSettingsStore.setState({ keybindingOverrides: {} });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root.render(<KeyboardSection />));
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function pill(action: string): HTMLButtonElement {
	const el = container.querySelector<HTMLButtonElement>(
		`button[aria-label^="Shortcut for ${action}:"]`,
	);
	if (!el) throw new Error(`no pill for ${action}`);
	return el;
}

function press(
	key: string,
	code: string,
	mods: Partial<
		Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>
	> = {},
) {
	act(() => {
		window.dispatchEvent(
			new KeyboardEvent("keydown", { key, code, bubbles: true, ...mods }),
		);
	});
}

const mod = isMac ? { metaKey: true } : { ctrlKey: true };
const overrides = () => useSettingsStore.getState().keybindingOverrides;

describe("KeyboardSection", () => {
	it("records a new chord into the store", () => {
		act(() => pill("Toggle git panel").click());
		press("Y", "KeyY", { ...mod, shiftKey: true });
		expect(overrides()["app:toggle-right-sidebar-git"]).toMatchObject({
			key: "y",
			shift: true,
		});
	});

	it("Esc cancels without writing, and does not reach the document", () => {
		const docListener = vi.fn();
		document.addEventListener("keydown", docListener, true);
		act(() => pill("New tab").click());
		press("Escape", "Escape");
		document.removeEventListener("keydown", docListener, true);
		expect(overrides()).toEqual({});
		expect(docListener).not.toHaveBeenCalled();
		expect(pill("New tab").getAttribute("aria-pressed")).toBe("false");
	});

	it("Backspace unbinds", () => {
		act(() => pill("Close tab").click());
		press("Backspace", "Backspace");
		expect(overrides()).toEqual({ "app:close-tab": null });
		expect(pill("Close tab").textContent).toBe("Unbound");
	});

	it("refused chords never reach the store", () => {
		act(() => pill("New tab").click());
		press("q", "KeyQ", mod);
		press("g", "KeyG");
		expect(overrides()).toEqual({});
		expect(container.textContent).toMatch(/app menu/);
	});

	it("asks before taking a chord another app action uses, and Reassign moves it", () => {
		act(() => pill("New tab").click());
		// The Command palette's default: Cmd/Ctrl+K.
		press("k", "KeyK", mod);
		expect(overrides()).toEqual({});
		expect(container.textContent).toMatch(/already used by “Command palette”/);
		const reassign = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent === "Reassign",
		);
		act(() => reassign?.click());
		expect(overrides()["app:new-tab"]).toMatchObject({ key: "k" });
		expect(overrides()["app:command-palette"]).toBeNull();
	});

	it("recording a row's default clears its Override", () => {
		act(() =>
			useSettingsStore.setState({
				keybindingOverrides: { "app:new-tab": null },
			}),
		);
		act(() => pill("New tab").click());
		press("t", "KeyT", mod);
		expect(overrides()).toEqual({});
	});

	it("per-row reset and Reset all", () => {
		act(() =>
			useSettingsStore.setState({
				keybindingOverrides: { "app:new-tab": null, "app:close-tab": null },
			}),
		);
		const reset = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Reset New tab to its default"]',
		);
		act(() => reset?.click());
		expect(overrides()).toEqual({ "app:close-tab": null });
		const all = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Reset all"),
		);
		act(() => all?.click());
		expect(overrides()).toEqual({});
	});

	it("shows a retry when the editor cannot be loaded", async () => {
		const tab = Array.from(container.querySelectorAll('[role="tab"]')).find(
			(b) => b.textContent === "Editor",
		) as HTMLButtonElement;
		await act(async () => tab.click());
		expect(container.textContent).toMatch(/could not be loaded/);
		expect(
			Array.from(container.querySelectorAll("button")).some(
				(b) => b.textContent === "Retry",
			),
		).toBe(true);
	});
});
