import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();

vi.mock("../../lib/ipc", () => ({
	updates: {
		status: () => status(),
		check: vi.fn(),
		download: vi.fn(),
		installNow: vi.fn(),
	},
}));

import { useSettingsStore } from "../settingsStore";
import { useUpdateStore } from "../updateStore";

const INFO = {
	version: "1.12.0",
	currentVersion: "1.11.1",
	body: null,
	date: null,
};

function resetStores() {
	useUpdateStore.setState({
		status: "idle",
		info: null,
		downloaded: 0,
		total: null,
		error: null,
		dismissed: false,
	});
	useSettingsStore.setState({
		skippedUpdateVersion: null,
		updateSnoozedUntil: null,
	});
}

describe("updateStore.hydrate", () => {
	beforeEach(() => {
		status.mockReset();
		resetStores();
	});

	it("adopts a staged update as ready", async () => {
		status.mockResolvedValue({ state: "ready", info: INFO });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("ready");
		expect(useUpdateStore.getState().info).toEqual(INFO);
	});

	it("adopts a checked-but-undownloaded update as available", async () => {
		status.mockResolvedValue({ state: "available", info: INFO });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("available");
	});

	it("leaves the store alone when Rust holds nothing", async () => {
		status.mockResolvedValue({ state: "none", info: null });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	// The prompt is a notification: "Skip this version" and "Later" must survive
	// a hydrate, or opening a new Window would silently defeat them.
	it("respects a skipped version when suppression is on", async () => {
		status.mockResolvedValue({ state: "ready", info: INFO });
		useSettingsStore.setState({ skippedUpdateVersion: "1.12.0" });
		await useUpdateStore.getState().hydrate({ respectSuppression: true });
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	it("respects an active snooze when suppression is on", async () => {
		status.mockResolvedValue({ state: "ready", info: INFO });
		useSettingsStore.setState({ updateSnoozedUntil: Date.now() + 60_000 });
		await useUpdateStore.getState().hydrate({ respectSuppression: true });
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	// The Settings section is a status display, not a notification — it must
	// report the truth even while the prompt is silenced.
	it("ignores suppression when asked to", async () => {
		status.mockResolvedValue({ state: "ready", info: INFO });
		useSettingsStore.setState({
			skippedUpdateVersion: "1.12.0",
			updateSnoozedUntil: Date.now() + 60_000,
		});
		await useUpdateStore.getState().hydrate({ respectSuppression: false });
		expect(useUpdateStore.getState().status).toBe("ready");
	});

	// A snapshot is staler than work this Window is already doing.
	it("does not clobber an in-flight download", async () => {
		status.mockResolvedValue({ state: "available", info: INFO });
		useUpdateStore.setState({ status: "downloading", info: INFO });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("downloading");
		expect(status).not.toHaveBeenCalled();
	});

	it("does not clobber an in-flight check", async () => {
		status.mockResolvedValue({ state: "ready", info: INFO });
		useUpdateStore.setState({ status: "checking" });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("checking");
	});

	it("swallows a failed status call", async () => {
		status.mockRejectedValue(new Error("no updater"));
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("idle");
		expect(useUpdateStore.getState().error).toBeNull();
	});
});
