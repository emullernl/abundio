import { beforeEach, describe, expect, it, vi } from "vitest";

const releaseNotes = vi.fn();
const markVersionSeen = vi.fn(() => Promise.resolve());

vi.mock("../../lib/ipc", () => ({
	updates: {
		releaseNotes: (refresh: boolean) => releaseNotes(refresh),
		markVersionSeen: () => markVersionSeen(),
		status: () => Promise.resolve({ state: "none", info: null }),
	},
}));
vi.mock("../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: () => ({
		variant: "dark",
		ui: {},
		terminal: { background: "#000" },
	}),
	themeList: () => [],
}));

import type { ReleaseNote } from "../../lib/ipc";
import { useUpdateStore } from "../updateStore";

const NOTE: ReleaseNote = {
	version: "0.4.0",
	body: "what changed",
	publishedAt: null,
	url: "https://example.test/0.4.0",
};

beforeEach(() => {
	releaseNotes.mockReset().mockResolvedValue([NOTE]);
	markVersionSeen.mockClear();
	useUpdateStore.setState({
		notes: null,
		notesStatus: "idle",
		whatsNew: null,
	});
});

describe("fetchNotes", () => {
	it("stores the list and marks itself loaded", async () => {
		await useUpdateStore.getState().fetchNotes();
		expect(useUpdateStore.getState().notes).toEqual([NOTE]);
		expect(useUpdateStore.getState().notesStatus).toBe("loaded");
	});

	it("passes the refresh flag through to Rust", async () => {
		await useUpdateStore.getState().fetchNotes({ refresh: true });
		expect(releaseNotes).toHaveBeenCalledWith(true);
	});

	it("records an error rather than throwing", async () => {
		releaseNotes.mockRejectedValue(new Error("offline"));
		await useUpdateStore.getState().fetchNotes();
		expect(useUpdateStore.getState().notesStatus).toBe("error");
		expect(useUpdateStore.getState().notes).toBeNull();
	});

	it("does not start a second fetch while one is in flight", async () => {
		let release!: (v: ReleaseNote[]) => void;
		releaseNotes.mockReturnValue(
			new Promise<ReleaseNote[]>((resolve) => {
				release = resolve;
			}),
		);
		const first = useUpdateStore.getState().fetchNotes();
		await useUpdateStore.getState().fetchNotes();
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		release([NOTE]);
		await first;
	});
});

describe("whatsNew", () => {
	it("holds the note Rust sent", () => {
		useUpdateStore.getState().setWhatsNew(NOTE);
		expect(useUpdateStore.getState().whatsNew).toEqual(NOTE);
	});

	it("clears the card and records the version as seen app-globally", () => {
		useUpdateStore.getState().setWhatsNew(NOTE);
		useUpdateStore.getState().dismissWhatsNew();
		expect(useUpdateStore.getState().whatsNew).toBeNull();
		// Rust owns the flag — localStorage is per-webview on macOS.
		expect(markVersionSeen).toHaveBeenCalledTimes(1);
	});

	it("still clears the card when recording the version fails", () => {
		markVersionSeen.mockRejectedValueOnce(new Error("db locked"));
		useUpdateStore.getState().setWhatsNew(NOTE);
		expect(() => useUpdateStore.getState().dismissWhatsNew()).not.toThrow();
		expect(useUpdateStore.getState().whatsNew).toBeNull();
	});
});
