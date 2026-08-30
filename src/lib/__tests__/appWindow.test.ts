import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentWindow = vi.fn();
const getCurrentWebview = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => getCurrentWindow(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
	getCurrentWebview: () => getCurrentWebview(),
}));

import { appWebview, appWindow, currentWindowLabel } from "../appWindow";

describe("appWindow", () => {
	beforeEach(() => {
		getCurrentWindow.mockReset();
		getCurrentWebview.mockReset();
	});

	it("returns the window when running inside Tauri", () => {
		const win = { label: "window-abc" };
		getCurrentWindow.mockReturnValue(win);
		expect(appWindow()).toBe(win);
		expect(currentWindowLabel()).toBe("window-abc");
	});

	it("returns null when Tauri's internals are missing", () => {
		// What `getCurrentWindow()` actually does in a plain browser: it reads
		// `window.__TAURI_INTERNALS__.metadata` and throws.
		getCurrentWindow.mockImplementation(() => {
			throw new TypeError(
				"Cannot read properties of undefined (reading 'metadata')",
			);
		});
		expect(appWindow()).toBeNull();
		expect(currentWindowLabel()).toBe("main");
	});

	it("returns null when the API resolves to undefined", () => {
		getCurrentWindow.mockReturnValue(undefined);
		expect(appWindow()).toBeNull();
		expect(currentWindowLabel()).toBe("main");
	});

	it("guards the webview the same way", () => {
		const webview = { label: "main" };
		getCurrentWebview.mockReturnValue(webview);
		expect(appWebview()).toBe(webview);
		getCurrentWebview.mockImplementation(() => {
			throw new TypeError("no internals");
		});
		expect(appWebview()).toBeNull();
	});
});
