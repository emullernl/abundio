import { describe, expect, it } from "vitest";
import {
	nextPreviewColorMode,
	resolvePreviewColorMode,
} from "../previewColorMode";

describe("resolvePreviewColorMode", () => {
	it("follows the theme variant in auto mode", () => {
		expect(resolvePreviewColorMode("auto", "dark")).toBe("dark");
		expect(resolvePreviewColorMode("auto", "light")).toBe("light");
	});

	it("forces light regardless of theme variant when set to light", () => {
		expect(resolvePreviewColorMode("light", "dark")).toBe("light");
		expect(resolvePreviewColorMode("light", "light")).toBe("light");
	});

	it("never resolves to dark unless the theme itself is dark", () => {
		// There is no forced-dark mode — dark only ever arrives via the theme.
		expect(resolvePreviewColorMode("light", "dark")).not.toBe("dark");
	});
});

describe("nextPreviewColorMode", () => {
	it("toggles between auto and light", () => {
		expect(nextPreviewColorMode("auto")).toBe("light");
		expect(nextPreviewColorMode("light")).toBe("auto");
	});

	it("is its own inverse — toggling twice returns to the start", () => {
		expect(nextPreviewColorMode(nextPreviewColorMode("auto"))).toBe("auto");
		expect(nextPreviewColorMode(nextPreviewColorMode("light"))).toBe("light");
	});
});
