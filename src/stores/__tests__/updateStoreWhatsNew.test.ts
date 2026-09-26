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
		whatsNewOrigin: "upgrade",
		whatsNewMissing: null,
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

		it("joins a duplicate plain fetch instead of starting another", async () => {
			const first = deferred();
			releaseNotes.mockReturnValue(first.promise);
			const inFlight = useUpdateStore.getState().fetchNotes();
			const duplicate = useUpdateStore.getState().fetchNotes();
			expect(releaseNotes).toHaveBeenCalledTimes(1);
			first.resolve(PAGE);
			await Promise.all([inFlight, duplicate]);
			// The second caller waited for the data rather than returning early.
			expect(useUpdateStore.getState().notes).toEqual(PAGE);
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

describe("toggleWhatsNew (status-bar version button)", () => {
	it("opens the card on the running version's notes", async () => {
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		expect(useUpdateStore.getState().whatsNew).toEqual(NOTE);
		expect(useUpdateStore.getState().whatsNewOrigin).toBe("manual");
		expect(useUpdateStore.getState().whatsNewMissing).toBeNull();
	});

	it("opens on an empty note when the version was never published", async () => {
		await useUpdateStore.getState().toggleWhatsNew("0.9.0");
		const note = useUpdateStore.getState().whatsNew;
		expect(note?.version).toBe("0.9.0");
		expect(note?.body).toBe("");
		expect(useUpdateStore.getState().whatsNewMissing).toBe("unpublished");
	});

	it("still opens when the notes fetch fails", async () => {
		releaseNotes.mockRejectedValue(new Error("offline"));
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		expect(useUpdateStore.getState().whatsNew?.body).toBe("");
		expect(useUpdateStore.getState().whatsNewMissing).toBe("failed");
	});

	it("says the notes are older when the version fell off the page", async () => {
		releaseNotes.mockResolvedValue({ releases: [NOTE], hasMore: true });
		await useUpdateStore.getState().toggleWhatsNew("0.1.0");
		expect(useUpdateStore.getState().whatsNewMissing).toBe("older");
	});

	it("closes the card when it is already open", async () => {
		useUpdateStore.getState().setWhatsNew(NOTE);
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		expect(useUpdateStore.getState().whatsNew).toBeNull();
		expect(releaseNotes).not.toHaveBeenCalled();
	});

	it("joins the fetch in flight instead of reading a half-loaded store", async () => {
		let resolve!: (v: typeof PAGE) => void;
		releaseNotes.mockReturnValue(
			new Promise<typeof PAGE>((r) => {
				resolve = r;
			}),
		);
		// Any other caller — here a plain fetchNotes — started the fetch first.
		const other = useUpdateStore.getState().fetchNotes();
		const toggle = useUpdateStore.getState().toggleWhatsNew("0.4.0");
		resolve(PAGE);
		await Promise.all([other, toggle]);
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		expect(useUpdateStore.getState().whatsNew).toEqual(NOTE);
		expect(useUpdateStore.getState().whatsNewMissing).toBeNull();
	});

	it("does not mark the version seen when closing an empty manual card", async () => {
		releaseNotes.mockRejectedValue(new Error("offline"));
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		expect(useUpdateStore.getState().whatsNew).toBeNull();
		// Would otherwise suppress the real post-upgrade card for good.
		expect(markVersionSeen).not.toHaveBeenCalled();
	});

	it("marks the version seen when closing a manual card that showed notes", async () => {
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		expect(markVersionSeen).toHaveBeenCalledTimes(1);
	});

	it("opens once on a second click while the first is still fetching", async () => {
		let resolve!: (v: typeof PAGE) => void;
		releaseNotes.mockReturnValue(
			new Promise<typeof PAGE>((r) => {
				resolve = r;
			}),
		);
		const first = useUpdateStore.getState().toggleWhatsNew("0.4.0");
		const second = useUpdateStore.getState().toggleWhatsNew("0.4.0");
		// Neither click opens the card before the notes arrive — an early open
		// would show the fallback card.
		await Promise.resolve();
		expect(useUpdateStore.getState().whatsNew).toBeNull();
		resolve(PAGE);
		await Promise.all([first, second]);
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		expect(useUpdateStore.getState().whatsNew).toEqual(NOTE);
	});

	it("keeps an upgrade card that arrived during the fetch", async () => {
		const upgrade = { ...NOTE, body: "upgrade notes" };
		releaseNotes.mockImplementation(async () => {
			useUpdateStore.getState().setWhatsNew(upgrade);
			return PAGE;
		});
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		expect(useUpdateStore.getState().whatsNew).toEqual(upgrade);
		expect(useUpdateStore.getState().whatsNewOrigin).toBe("upgrade");
	});

	it("setWhatsNew marks the card as an upgrade", async () => {
		await useUpdateStore.getState().toggleWhatsNew("0.4.0");
		useUpdateStore.getState().setWhatsNew(NOTE);
		expect(useUpdateStore.getState().whatsNewOrigin).toBe("upgrade");
	});
});
