import { describe, expect, it } from "vitest";
import {
	DEFAULT_SECTION,
	initialSection,
	normalizeSection,
	SETTINGS_NAV,
	SETTINGS_SECTIONS,
} from "../settingsSections";

describe("normalizeSection", () => {
	it.each(SETTINGS_SECTIONS)("round-trips %s", (id) => {
		expect(normalizeSection(id)).toBe(id);
	});

	it.each([
		["terminal-font", "fonts"],
		["ui-font", "fonts"],
		["shell", "terminal"],
	])("maps the legacy id %s to %s", (legacy, expected) => {
		expect(normalizeSection(legacy)).toBe(expected);
	});

	it("does not accept group captions — they are not addressable", () => {
		expect(normalizeSection("appearance")).toBeNull();
		expect(normalizeSection("panes")).toBeNull();
		expect(normalizeSection("application")).toBeNull();
	});

	it.each([["nope"], [""], [null], [undefined]])("rejects %s", (raw:
		| string
		| null
		| undefined) => {
		expect(normalizeSection(raw)).toBeNull();
	});
});

describe("initialSection", () => {
	// The regression test for the cold-open deep link: Rust encodes the section
	// into the window URL, and nothing used to read it back.
	it("reads the section from the window URL", () => {
		expect(initialSection("?settings&section=profiles")).toBe("profiles");
		expect(initialSection("?settings&section=github")).toBe("github");
	});

	it("resolves a legacy id from a stale URL", () => {
		expect(initialSection("?settings&section=shell")).toBe("terminal");
		expect(initialSection("?settings&section=ui-font")).toBe("fonts");
	});

	it("falls back to the default when no section is requested", () => {
		expect(initialSection("?settings")).toBe(DEFAULT_SECTION);
		expect(initialSection("")).toBe(DEFAULT_SECTION);
		expect(initialSection("?settings&section=nope")).toBe(DEFAULT_SECTION);
	});
});

describe("SETTINGS_NAV", () => {
	const navIds = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.id));

	// A leaf added to the union but forgotten in the rail would be reachable by
	// deep link and invisible in the UI — and vice versa.
	it("lists every section exactly once", () => {
		expect(navIds.slice().sort()).toEqual(
			SETTINGS_SECTIONS.slice().sort() as string[],
		);
	});

	it("has a caption and at least two leaves per group", () => {
		for (const group of SETTINGS_NAV) {
			expect(group.caption).not.toBe("");
			expect(group.items.length).toBeGreaterThanOrEqual(2);
		}
	});

	it("opens on a section that exists", () => {
		expect(navIds).toContain(DEFAULT_SECTION);
	});
});
