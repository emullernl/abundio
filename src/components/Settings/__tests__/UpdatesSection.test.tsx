import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { check, status, releaseNotes } = vi.hoisted(() => ({
	check: vi.fn(),
	status: vi.fn(),
	releaseNotes: vi.fn(),
}));

vi.mock("../../../lib/ipc", () => ({
	updates: {
		check,
		status,
		releaseNotes: (refresh: boolean) => releaseNotes(refresh),
		markVersionSeen: () => Promise.resolve(),
		setAutoCheck: () => Promise.resolve(),
		onDownloadProgress: () => Promise.resolve(() => {}),
	},
	agentHooks: { provision: () => Promise.resolve() },
}));
vi.mock("@tauri-apps/api/app", () => ({
	getVersion: () => Promise.resolve("1.0.0"),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: () => Promise.resolve() }));
vi.mock("../../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: () => ({
		variant: "dark",
		ui: {},
		terminal: { background: "#000" },
	}),
	themeList: () => [],
}));
vi.mock("../ReleaseNotesMarkdown", () => ({
	ReleaseNotesMarkdown: ({ body }: { body: string }) => <div>{body}</div>,
}));

import { useUpdateStore } from "../../../stores/updateStore";
import { UpdatesSection } from "../UpdatesSection";

const note = (version: string) => ({
	version,
	body: `notes for ${version}`,
	publishedAt: null,
	url: `https://example.test/${version}`,
});

let container: HTMLDivElement;
// biome-ignore lint/suspicious/noExplicitAny: React 19 root handle
let root: any;

async function mount() {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<UpdatesSection />);
	});
}

async function unmount() {
	await act(async () => root.unmount());
	container.remove();
}

beforeEach(() => {
	vi.clearAllMocks();
	useUpdateStore.setState({
		status: "idle",
		info: null,
		error: null,
		lastCheckedAt: null,
		notes: null,
		notesStatus: "idle",
	});
	status.mockResolvedValue({ state: "none", info: null });
	releaseNotes.mockResolvedValue({ releases: [note("1.0.0")], hasMore: false });
});

afterEach(async () => {
	if (container?.isConnected) await unmount();
});

describe("UpdatesSection (issue #200)", () => {
	it("checks for an update on mount, and not again on a quick remount", async () => {
		check.mockResolvedValue(null);
		await mount();
		expect(check).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("You're up to date.");

		await unmount();
		await mount();
		expect(check).toHaveBeenCalledTimes(1);
	});

	it("refreshes the notes once when the found version is missing from them", async () => {
		check.mockResolvedValue({
			version: "1.1.0",
			currentVersion: "1.0.0",
			body: null,
			date: null,
		});
		await mount();
		expect(container.textContent).toContain("Version 1.1.0 is available.");
		expect(releaseNotes).toHaveBeenCalledWith(false);
		expect(releaseNotes).toHaveBeenCalledWith(true);
		// Still missing after the refresh: no loop.
		expect(releaseNotes).toHaveBeenCalledTimes(2);
	});

	it("does not refresh the notes when they already include the found version", async () => {
		releaseNotes.mockResolvedValue({
			releases: [note("1.1.0"), note("1.0.0")],
			hasMore: false,
		});
		check.mockResolvedValue({
			version: "1.1.0",
			currentVersion: "1.0.0",
			body: null,
			date: null,
		});
		await mount();
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		expect(releaseNotes).toHaveBeenCalledWith(false);
	});
});
