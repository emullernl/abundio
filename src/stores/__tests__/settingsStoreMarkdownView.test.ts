import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/themes", () => ({
	applyTheme: vi.fn(),
	getTheme: vi.fn((name: string) => ({
		name,
		displayName: name,
		ui: {},
		terminal: { background: "#000" },
	})),
}));

import { useSettingsStore } from "../settingsStore";

const migrate = (state: object, version: number) => {
	const fn = useSettingsStore.persist.getOptions().migrate;
	if (!fn) throw new Error("expected a migrate function");
	return fn(state, version) as Record<string, unknown>;
};

describe("Open markdown rendered (v18)", () => {
	it("carries the old auto-open answer over and drops the old key", () => {
		const off = migrate({ markdownPreviewAutoOpen: false }, 17);
		expect(off.markdownOpenRendered).toBe(false);
		expect("markdownPreviewAutoOpen" in off).toBe(false);
		expect(
			migrate({ markdownPreviewAutoOpen: true }, 17).markdownOpenRendered,
		).toBe(true);
	});

	it("defaults to on when the old key was never stored", () => {
		expect(migrate({}, 17).markdownOpenRendered).toBe(true);
	});

	it("leaves a v18 snapshot alone", () => {
		expect(
			migrate({ markdownOpenRendered: false }, 18).markdownOpenRendered,
		).toBe(false);
	});
});
