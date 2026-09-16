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

const PAGE = { releases: [NOTE], hasMore: false };

beforeEach(() => {
	releaseNotes.mockReset().mockResolvedValue(PAGE);
	markVersionSeen.mockClear();
	useUpdateStore.setState({
		notes: null,
		notesStatus: "idle",
		whatsNew: null,
	});
});

describe("fetchNotes", () => {
	it("stores the page and marks itself loaded", async () => {
		await useUpdateStore.getState().fetchNotes();
		expect(useUpdateStore.getState().notes).toEqual(PAGE);
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

	it("keeps an already-loaded page when a later fetch fails", async () => {
		await useUpdateStore.getState().fetchNotes();
		releaseNotes.mockRejectedValue(new Error("offline"));
		await useUpdateStore.getState().fetchNotes({ refresh: true });
		expect(useUpdateStore.getState().notesStatus).toBe("error");
		// The view falls back to what it had rather than blanking out.
		expect(useUpdateStore.getState().notes).toEqual(PAGE);
	});

	describe("the in-flight guard", () => {
		function deferred() {
			let resolve!: (v: typeof PAGE) => void;
			const promise = new Promise<typeof PAGE>((r) => {
				resolve = r;
			});
			return { promise, resolve };
		}

		it("drops a duplicate plain fetch", async () => {
			const first = deferred();
			releaseNotes.mockReturnValue(first.promise);
			const inFlight = useUpdateStore.getState().fetchNotes();
			await useUpdateStore.getState().fetchNotes();
			expect(releaseNotes).toHaveBeenCalledTimes(1);
			first.resolve(PAGE);
			await inFlight;
		});

		/// The Settings window opens straight onto this section, so clicking
		/// "Check for updates" while the mount fetch is still resolving is a real
		/// window, not an engineered race. Dropping it would serve the hourly
		/// cache to someone who explicitly asked for current truth.
		it("lets a refresh through while a plain fetch is in flight", async () => {
			const first = deferred();
			releaseNotes.mockReturnValue(first.promise);
			const inFlight = useUpdateStore.getState().fetchNotes();

			releaseNotes.mockResolvedValue(PAGE);
			await useUpdateStore.getState().fetchNotes({ refresh: true });

			expect(releaseNotes).toHaveBeenCalledTimes(2);
			expect(releaseNotes).toHaveBeenLastCalledWith(true);
			first.resolve(PAGE);
			await inFlight;
		});
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
