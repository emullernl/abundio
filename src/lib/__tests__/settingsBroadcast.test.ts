import { describe, expect, it, vi } from "vitest";

vi.mock("../themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn((name: string) => ({
		name,
		displayName: name,
		ui: {},
		terminal: { background: "#000" },
	})),
}));

vi.mock("../terminalManager", () => ({
	setAllTerminalsTheme: vi.fn(),
	setAllTerminalsFontFamily: vi.fn(),
	setAllTerminalsFontSize: vi.fn(),
	setAllTerminalsScrollback: vi.fn(),
	setActivityByteThreshold: vi.fn(),
	setWebglEnabled: vi.fn(),
}));

import { PERSISTED_KEYS, useSettingsStore } from "../../stores/settingsStore";
import {
	BROADCAST_KEYS,
	broadcastSliceOf,
	NOT_BROADCAST,
} from "../settingsBroadcast";

function persistedState(): Record<string, unknown> {
	const partialize = useSettingsStore.persist.getOptions().partialize;
	if (!partialize) throw new Error("settingsStore has no partialize");
	return partialize(useSettingsStore.getState()) as Record<string, unknown>;
}

describe("settingsBroadcast", () => {
	it("only denies keys that are actually persisted", () => {
		// A renamed or removed setting must not rot the denylist silently — the
		// denylist is only meaningful as a subset of what persist writes.
		const persisted = new Set<string>(PERSISTED_KEYS);
		for (const key of NOT_BROADCAST) {
			expect(persisted.has(key), `${key} is not a persisted key`).toBe(true);
		}
	});

	it("broadcasts every persisted key except the denied ones", () => {
		expect(new Set(BROADCAST_KEYS)).toEqual(
			new Set(PERSISTED_KEYS.filter((k) => !NOT_BROADCAST.has(k))),
		);
		expect(BROADCAST_KEYS.length).toBe(
			PERSISTED_KEYS.length - NOT_BROADCAST.size,
		);
	});

	// The regressions that motivated deriving the slice: each is a global setting
	// the hand-written list had forgotten, so it never left its own Window.
	// `debugActivityMeter` matters most — its only consumer is TerminalSlot, and
	// the Settings window owns no terminals, so its new Diagnostics toggle would
	// be a permanent no-op without this.
	it.each([
		"shellPath",
		"autoCheckUpdatesEnabled",
		"editorWordWrap",
		"debugActivityMeter",
		"markdownPreviewAutoOpen",
	])("includes %s in the broadcast slice", (key) => {
		expect(Object.keys(broadcastSliceOf(persistedState()))).toContain(key);
	});

	it("excludes drag-derived widths and write-on-use breadcrumbs", () => {
		const keys = Object.keys(broadcastSliceOf(persistedState()));
		for (const denied of NOT_BROADCAST) {
			expect(keys).not.toContain(denied);
		}
	});

	it("survives an emit round trip for a present-but-undefined key", () => {
		// `emit` JSON-serialises, dropping undefined values. If the two sides
		// projected differently the self-echo guard would never match and the
		// windows would emit at each other forever.
		const published = broadcastSliceOf({ theme: undefined });
		const received = JSON.parse(JSON.stringify(published));
		expect(broadcastSliceOf(received)).toEqual(published);
		expect(published).toEqual({ theme: null });
	});

	it("omits absent keys rather than emitting them as undefined", () => {
		// The receiving side projects an event payload that already holds only
		// broadcast keys; both sides must fingerprint identically.
		const roundTripped = broadcastSliceOf(
			broadcastSliceOf(persistedState()) as Record<string, unknown>,
		);
		expect(roundTripped).toEqual(broadcastSliceOf(persistedState()));
		expect(Object.keys(broadcastSliceOf({ theme: "dark" }))).toEqual(["theme"]);
	});
});
