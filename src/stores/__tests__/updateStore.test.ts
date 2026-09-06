import { beforeEach, describe, expect, it, vi } from "vitest";

const { check, download, installNow, status, setAutoCheck, provision } =
	vi.hoisted(() => ({
		check: vi.fn(),
		download: vi.fn(),
		installNow: vi.fn(),
		status: vi.fn(),
		setAutoCheck: vi.fn(() => Promise.resolve()),
		provision: vi.fn(() => Promise.resolve()),
	}));

vi.mock("../../lib/ipc", () => ({
	// updateStore + settingsStore both import from ipc; provide both surfaces.
	updates: {
		check,
		download,
		installNow,
		status,
		setAutoCheck,
		onUpdateAvailable: vi.fn(),
		onDownloadProgress: vi.fn(),
	},
	agentHooks: { provision },
}));

import { useSettingsStore } from "../settingsStore";
import { useUpdateStore } from "../updateStore";

const info = (version: string) => ({
	version,
	currentVersion: "1.0.0",
	body: null,
	date: null,
});

function reset() {
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
	vi.clearAllMocks();
}

const HOUR_MS = 60 * 60 * 1000;

describe("updateStore", () => {
	beforeEach(reset);

	it("setAvailable surfaces a new update", () => {
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		const s = useUpdateStore.getState();
		expect(s.status).toBe("available");
		expect(s.info?.version).toBe("1.4.0");
		expect(s.dismissed).toBe(false);
	});

	it("setAvailable ignores a skipped version", () => {
		useSettingsStore.setState({ skippedUpdateVersion: "1.4.0" });
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	it("manual check with no update reports up to date", async () => {
		check.mockResolvedValueOnce(null);
		await useUpdateStore.getState().check({ manual: true });
		expect(useUpdateStore.getState().status).toBe("uptodate");
	});

	it("auto check suppresses a skipped version", async () => {
		useSettingsStore.setState({ skippedUpdateVersion: "1.4.0" });
		check.mockResolvedValueOnce(info("1.4.0"));
		await useUpdateStore.getState().check();
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	it("manual check surfaces even a skipped version", async () => {
		useSettingsStore.setState({ skippedUpdateVersion: "1.4.0" });
		check.mockResolvedValueOnce(info("1.4.0"));
		await useUpdateStore.getState().check({ manual: true });
		expect(useUpdateStore.getState().status).toBe("available");
	});

	it("skipVersion persists the version and dismisses the prompt", () => {
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		useUpdateStore.getState().skipVersion();
		expect(useSettingsStore.getState().skippedUpdateVersion).toBe("1.4.0");
		expect(useUpdateStore.getState().dismissed).toBe(true);
	});

	it("dismissLater snoozes ~24h and dismisses the prompt", () => {
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		const before = Date.now();
		useUpdateStore.getState().dismissLater();
		const until = useSettingsStore.getState().updateSnoozedUntil;
		expect(until).not.toBeNull();
		// ~24h out, allowing a little slack for clock movement during the test.
		expect(until).toBeGreaterThanOrEqual(before + 24 * HOUR_MS - 1000);
		expect(until).toBeLessThanOrEqual(Date.now() + 24 * HOUR_MS + 1000);
		expect(useUpdateStore.getState().dismissed).toBe(true);
	});

	it("setAvailable ignores updates while snoozed", () => {
		useSettingsStore.setState({ updateSnoozedUntil: Date.now() + HOUR_MS });
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	it("setAvailable surfaces updates once the snooze has expired", () => {
		useSettingsStore.setState({ updateSnoozedUntil: Date.now() - HOUR_MS });
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		expect(useUpdateStore.getState().status).toBe("available");
	});

	it("auto check suppresses while snoozed", async () => {
		useSettingsStore.setState({ updateSnoozedUntil: Date.now() + HOUR_MS });
		check.mockResolvedValueOnce(info("1.4.0"));
		await useUpdateStore.getState().check();
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	it("manual check surfaces even while snoozed", async () => {
		useSettingsStore.setState({ updateSnoozedUntil: Date.now() + HOUR_MS });
		check.mockResolvedValueOnce(info("1.4.0"));
		await useUpdateStore.getState().check({ manual: true });
		expect(useUpdateStore.getState().status).toBe("available");
	});

	it("download transitions available → downloading → ready", async () => {
		let resolveDownload: () => void = () => {};
		download.mockImplementationOnce(
			() =>
				new Promise<void>((r) => {
					resolveDownload = r;
				}),
		);
		useUpdateStore.getState().setAvailable(info("1.4.0"));
		const p = useUpdateStore.getState().download();
		expect(useUpdateStore.getState().status).toBe("downloading");
		resolveDownload();
		await p;
		expect(useUpdateStore.getState().status).toBe("ready");
	});
});

describe("updateStore.hydrate", () => {
	beforeEach(reset);

	it("adopts a staged update as ready", async () => {
		status.mockResolvedValueOnce({ state: "ready", info: info("1.4.0") });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("ready");
		expect(useUpdateStore.getState().info?.version).toBe("1.4.0");
	});

	it("adopts a checked-but-undownloaded update as available", async () => {
		status.mockResolvedValueOnce({ state: "available", info: info("1.4.0") });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("available");
	});

	it("leaves the store alone when Rust holds nothing", async () => {
		status.mockResolvedValueOnce({ state: "none", info: null });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	// The prompt is a notification: "Skip this version" and "Later" must survive
	// a hydrate, or opening a new Window would silently defeat them.
	it("respects a skipped version when suppression is on", async () => {
		status.mockResolvedValueOnce({ state: "ready", info: info("1.4.0") });
		useSettingsStore.setState({ skippedUpdateVersion: "1.4.0" });
		await useUpdateStore.getState().hydrate({ respectSuppression: true });
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	it("respects an active snooze when suppression is on", async () => {
		status.mockResolvedValueOnce({ state: "ready", info: info("1.4.0") });
		useSettingsStore.setState({ updateSnoozedUntil: Date.now() + HOUR_MS });
		await useUpdateStore.getState().hydrate({ respectSuppression: true });
		expect(useUpdateStore.getState().status).toBe("idle");
	});

	// The Settings section is a status display, not a notification — it must
	// report the truth even while the prompt is silenced.
	it("ignores suppression when asked to", async () => {
		status.mockResolvedValueOnce({ state: "ready", info: info("1.4.0") });
		useSettingsStore.setState({
			skippedUpdateVersion: "1.4.0",
			updateSnoozedUntil: Date.now() + HOUR_MS,
		});
		await useUpdateStore.getState().hydrate({ respectSuppression: false });
		expect(useUpdateStore.getState().status).toBe("ready");
	});

	// A snapshot is staler than work this Window is already doing.
	// No queued `status` value on purpose: these two must not reach the IPC at
	// all, and an unconsumed `...Once` would spill into the next test.
	it("does not clobber a download already in flight", async () => {
		useUpdateStore.setState({ status: "downloading", info: info("1.4.0") });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("downloading");
		expect(status).not.toHaveBeenCalled();
	});

	it("does not clobber a check already in flight", async () => {
		useUpdateStore.setState({ status: "checking" });
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("checking");
		expect(status).not.toHaveBeenCalled();
	});

	// The guard has to hold across the IPC round-trip too: a download started
	// while `updates.status()` was still in flight must survive the reply.
	it("does not clobber a download started during the round-trip", async () => {
		let resolveStatus: (v: unknown) => void = () => {};
		status.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveStatus = r;
				}),
		);
		download.mockImplementationOnce(() => new Promise<void>(() => {}));

		useUpdateStore.setState({ status: "available", info: info("1.4.0") });
		const hydrating = useUpdateStore.getState().hydrate();
		// The user clicks Install before the status reply lands.
		useUpdateStore.getState().download();
		expect(useUpdateStore.getState().status).toBe("downloading");

		resolveStatus({ state: "available", info: info("1.4.0") });
		await hydrating;
		expect(useUpdateStore.getState().status).toBe("downloading");
	});

	it("swallows a failed status call", async () => {
		status.mockRejectedValueOnce(new Error("no updater"));
		await useUpdateStore.getState().hydrate();
		expect(useUpdateStore.getState().status).toBe("idle");
		expect(useUpdateStore.getState().error).toBeNull();
	});
});
