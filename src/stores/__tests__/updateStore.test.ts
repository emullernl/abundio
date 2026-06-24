import { beforeEach, describe, expect, it, vi } from "vitest";

const { check, download, installNow, setAutoCheck, provision } = vi.hoisted(
	() => ({
		check: vi.fn(),
		download: vi.fn(),
		installNow: vi.fn(),
		setAutoCheck: vi.fn(() => Promise.resolve()),
		provision: vi.fn(() => Promise.resolve()),
	}),
);

vi.mock("../../lib/ipc", () => ({
	// updateStore + settingsStore both import from ipc; provide both surfaces.
	updates: {
		check,
		download,
		installNow,
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
