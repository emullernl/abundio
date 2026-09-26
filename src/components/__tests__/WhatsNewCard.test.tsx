import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/ipc", () => ({
	updates: {
		releaseNotes: () => Promise.resolve({ releases: [], hasMore: false }),
		markVersionSeen: () => Promise.resolve(),
		status: () => Promise.resolve({ state: "none", info: null }),
	},
}));

import { useUpdateStore } from "../../stores/updateStore";
import { WhatsNewCard } from "../WhatsNewCard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = {
	version: "1.2.3",
	body: "Fixed the thing",
	publishedAt: null,
	url: "https://example.test/1.2.3",
};

describe("WhatsNewCard", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		useUpdateStore.setState({
			whatsNew: null,
			whatsNewOrigin: "upgrade",
			whatsNewMissing: null,
		});
	});

	it("announces the upgrade when Rust sent the card", () => {
		act(() => useUpdateStore.getState().setWhatsNew(NOTE));
		act(() => root.render(<WhatsNewCard />));
		expect(container.textContent).toContain("You're now on Abundio 1.2.3");
		expect(container.textContent).toContain("Fixed the thing");
	});

	it("titles the card as release notes when opened from the version button", () => {
		act(() =>
			useUpdateStore.setState({ whatsNew: NOTE, whatsNewOrigin: "manual" }),
		);
		act(() => root.render(<WhatsNewCard />));
		expect(container.textContent).toContain("What's new in Abundio 1.2.3");
		expect(container.textContent).not.toContain("You're now on");
	});

	it("says so when the version has no published notes", () => {
		act(() =>
			useUpdateStore.setState({
				whatsNew: { ...NOTE, body: "" },
				whatsNewOrigin: "manual",
				whatsNewMissing: "unpublished",
			}),
		);
		act(() => root.render(<WhatsNewCard />));
		expect(container.textContent).toContain(
			"No release notes have been published for this version.",
		);
	});

	it("blames a failed fetch, not the release, when loading failed", () => {
		act(() =>
			useUpdateStore.setState({
				whatsNew: { ...NOTE, body: "" },
				whatsNewOrigin: "manual",
				whatsNewMissing: "failed",
			}),
		);
		act(() => root.render(<WhatsNewCard />));
		expect(container.textContent).toContain("Couldn't load the release notes");
		expect(container.textContent).not.toContain("No release notes have been");
	});
});
