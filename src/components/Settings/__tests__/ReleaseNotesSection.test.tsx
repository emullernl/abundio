import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releaseNotes = vi.fn();

vi.mock("../../../lib/ipc", () => ({
	updates: {
		releaseNotes: (refresh: boolean) => releaseNotes(refresh),
		markVersionSeen: () => Promise.resolve(),
		status: () => Promise.resolve({ state: "none", info: null }),
	},
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: () => Promise.resolve() }));
// settingsStore applies a theme at import time, so the mock needs the whole
// surface it touches, not just the `getTheme` this component reads.
vi.mock("../../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: () => ({
		variant: "dark",
		ui: {},
		terminal: { background: "#000" },
	}),
	themeList: () => [],
}));
// The Markdown renderer pulls in @uiw's ESM bundle and its stylesheet, neither
// of which jsdom needs to answer the questions below: this suite is about which
// releases appear, not how their bodies render.
vi.mock("../ReleaseNotesMarkdown", () => ({
	ReleaseNotesMarkdown: ({ body }: { body: string }) => (
		<div data-testid="notes-body">{body}</div>
	),
}));

import type { ReleaseNote } from "../../../lib/ipc";
import { useUpdateStore } from "../../../stores/updateStore";
import { ReleaseNotesSection } from "../ReleaseNotesSection";

function release(version: string): ReleaseNote {
	return {
		version,
		body: `notes for ${version}`,
		publishedAt: null,
		url: `https://example.test/${version}`,
	};
}

let container: HTMLDivElement;
// biome-ignore lint/suspicious/noExplicitAny: React 19 root handle
let root: any;

async function render(currentVersion: string) {
	await act(async () => {
		root.render(<ReleaseNotesSection currentVersion={currentVersion} />);
	});
}

beforeEach(() => {
	releaseNotes.mockReset();
	useUpdateStore.setState({
		notes: null,
		notesStatus: "idle",
		info: null,
		status: "idle",
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("ReleaseNotesSection", () => {
	it("fetches on mount, without spending a refresh", async () => {
		releaseNotes.mockResolvedValue([release("0.4.0")]);
		await render("0.4.0");
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		expect(releaseNotes).toHaveBeenCalledWith(false);
	});

	it("renders nothing until the running version is known", async () => {
		releaseNotes.mockResolvedValue([release("0.4.0")]);
		// An empty version would make the anchoring rule call every release newer.
		await render("");
		expect(container.textContent).toBe("");
	});

	it("still fetches while the version resolves — the list does not depend on it", async () => {
		releaseNotes.mockResolvedValue([release("0.4.0")]);
		await render("");
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		// And the arriving version renders from the same fetch, not a second one.
		await render("0.4.0");
		expect(releaseNotes).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("v0.4.0");
	});

	it("lists newer releases above the running one", async () => {
		releaseNotes.mockResolvedValue([
			release("0.6.0"),
			release("0.5.0"),
			release("0.4.0"),
		]);
		await render("0.4.0");
		const versions = [...container.querySelectorAll(".font-mono")].map(
			(el) => el.textContent,
		);
		expect(versions).toEqual(["v0.6.0", "v0.5.0", "v0.4.0"]);
		expect(container.textContent).toContain("What's new since 0.4.0");
		expect(container.textContent).toContain("you're running this");
	});

	it("expands exactly one release by default", async () => {
		releaseNotes.mockResolvedValue([release("0.6.0"), release("0.4.0")]);
		await render("0.4.0");
		expect(
			container.querySelectorAll("[data-testid='notes-body']"),
		).toHaveLength(1);
		expect(container.textContent).toContain("notes for 0.6.0");
	});

	it("expands and collapses on click", async () => {
		releaseNotes.mockResolvedValue([release("0.6.0"), release("0.4.0")]);
		await render("0.4.0");
		const rows = [...container.querySelectorAll("button[aria-expanded]")];
		expect(rows[1].getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			(rows[1] as HTMLButtonElement).click();
		});
		expect(rows[1].getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("notes for 0.4.0");
	});

	it("says a dev build has no published notes, and still shows history", async () => {
		releaseNotes.mockResolvedValue([release("0.4.0"), release("0.3.0")]);
		await render("0.9.0");
		expect(container.textContent).toContain(
			"No published release notes for v0.9.0",
		);
		expect(container.textContent).toContain("Recent releases");
		expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(2);
	});

	it("offers the older-releases link when the version fell off the page", async () => {
		releaseNotes.mockResolvedValue([release("0.6.0"), release("0.5.0")]);
		await render("0.1.0");
		expect(container.textContent).toContain("Older releases on GitHub");
	});

	describe("when the fetch fails", () => {
		it("falls back to the available update's own notes", async () => {
			releaseNotes.mockRejectedValue(new Error("offline"));
			useUpdateStore.setState({
				info: {
					version: "0.5.0",
					currentVersion: "0.4.0",
					body: "bundled notes",
					date: null,
				},
			});
			await render("0.4.0");
			expect(container.textContent).toContain("What's new in 0.5.0");
			expect(container.textContent).toContain("bundled notes");
			expect(container.textContent).toContain(
				"Couldn't load older release notes",
			);
		});

		it("says so plainly when there is no update to fall back on", async () => {
			releaseNotes.mockRejectedValue(new Error("offline"));
			await render("0.4.0");
			expect(container.textContent).toContain("Couldn't load release notes");
			expect(container.textContent).toContain("Retry");
		});

		it("spends a refresh on Retry", async () => {
			releaseNotes.mockRejectedValue(new Error("offline"));
			await render("0.4.0");
			const retry = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Retry",
			);
			releaseNotes.mockResolvedValue([release("0.4.0")]);
			await act(async () => {
				retry?.click();
			});
			expect(releaseNotes).toHaveBeenLastCalledWith(true);
			expect(container.textContent).toContain("Release notes");
		});
	});
});
