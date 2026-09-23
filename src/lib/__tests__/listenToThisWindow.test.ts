import { beforeEach, describe, expect, it, vi } from "vitest";

const { globalListen, webviewListen, current } = vi.hoisted(() => ({
	globalListen: vi.fn(() => Promise.resolve(() => {})),
	webviewListen: vi.fn(() => Promise.resolve(() => {})),
	current: { webview: null as { listen: unknown } | null },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: globalListen }));
vi.mock("../appWindow", () => ({
	appWebview: () => current.webview,
	appWindow: () => null,
	currentWindowLabel: () => "main",
}));
vi.mock("../demo", () => ({ isDemoMode: () => false }));

import { listenToThisWindow } from "../ipc";

beforeEach(() => {
	globalListen.mockClear();
	webviewListen.mockClear();
});

describe("listenToThisWindow", () => {
	// A global listener has target `Any`, which Tauri matches against every
	// `emit_to(label)` — so a one-Window event would reach every Window.
	it("listens on the current webview, never globally", async () => {
		current.webview = { listen: webviewListen };
		const cb = vi.fn();
		await listenToThisWindow("switch-profile-request", cb);
		expect(webviewListen).toHaveBeenCalledWith("switch-profile-request", cb);
		expect(globalListen).not.toHaveBeenCalled();
	});

	it("falls back to the global listener outside a Tauri webview", async () => {
		current.webview = null;
		await listenToThisWindow("pr-changes", vi.fn());
		expect(globalListen).toHaveBeenCalledOnce();
	});
});
