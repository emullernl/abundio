import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panel's leaves reach for the OS on mount (fonts, shells, hook status,
// app version, the updater). None of that exists under jsdom.
vi.mock("../../../lib/ipc", () => ({
	fonts: { listSystemFonts: () => Promise.resolve([]) },
	shells: { listAvailable: () => Promise.resolve([]) },
	agentHooks: { status: () => Promise.resolve([]) },
	fs: { revealInFolder: () => Promise.resolve() },
	updates: { onDownloadProgress: () => Promise.resolve(() => {}) },
	pr: {},
}));
vi.mock("@tauri-apps/api/app", () => ({
	getVersion: () => Promise.resolve("0.0.0"),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: () => Promise.resolve() }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: () => Promise.resolve(() => {}),
	emit: () => Promise.resolve(),
}));
vi.mock("../../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn((name: string) => ({
		name,
		displayName: name,
		ui: {},
		terminal: { background: "#000" },
	})),
	themeList: () => [],
}));
vi.mock("../../../lib/terminalManager", () => ({
	setAllTerminalsTheme: vi.fn(),
	setAllTerminalsFontFamily: vi.fn(),
	setAllTerminalsFontSize: vi.fn(),
	setAllTerminalsScrollback: vi.fn(),
	setActivityByteThreshold: vi.fn(),
	setWebglEnabled: vi.fn(),
}));

import { SETTINGS_NAV } from "../../../lib/settingsSections";
import { SettingsPanel } from "../../SettingsPanel";

const LEAF_LABELS = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.label));
const CAPTIONS = SETTINGS_NAV.map((g) => g.caption);

describe("SettingsPanel nav rail", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	function render() {
		act(() => {
			root.render(<SettingsPanel onClose={() => {}} />);
		});
	}

	function navButtons(): HTMLButtonElement[] {
		const nav = container.querySelector("nav");
		if (!nav) throw new Error("nav rail not rendered");
		return Array.from(nav.querySelectorAll("button"));
	}

	/** Resolved via aria-current, so a cosmetic restyle of the rail can't
	 *  silently break the deep-link regression tests below. */
	function activeLabel(): string | null | undefined {
		return container.querySelector('nav [aria-current="page"]')?.textContent;
	}

	beforeEach(() => {
		window.history.replaceState(null, "", "/?settings");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("renders every group caption over its leaf pages", () => {
		render();
		const nav = container.querySelector("nav");
		const text = nav?.textContent ?? "";
		for (const caption of CAPTIONS) expect(text).toContain(caption);
		expect(navButtons().map((b) => b.textContent)).toEqual(LEAF_LABELS);
	});

	it("makes only the leaves focusable — captions are not buttons", () => {
		render();
		// One clickable row per leaf: a caption that rendered as a button would
		// put a non-navigable stop in the Tab order.
		expect(navButtons()).toHaveLength(LEAF_LABELS.length);
	});

	// The regression test for the cold-open deep link: Rust encodes the section
	// into the window URL, and nothing used to read it back.
	it("opens on the deep-linked section and then clears it from the URL", () => {
		window.history.replaceState(null, "", "/?settings&section=profiles");
		render();
		expect(activeLabel()).toBe("Profiles");
		expect(window.location.search).not.toContain("section=");
	});

	it("resolves a legacy section id from a stale URL", () => {
		window.history.replaceState(null, "", "/?settings&section=shell");
		render();
		expect(activeLabel()).toBe("Terminal");
	});

	it("defaults to Theme when no section is requested", () => {
		render();
		expect(activeLabel()).toBe("Theme");
	});
});
