import type { ITheme } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
	normalFontWeightFor,
	parseHexBackground,
	transparentBg,
} from "../themeUtils";

const themeWith = (background: string | undefined): ITheme => ({
	background,
	foreground: "#abcdef",
});

describe("parseHexBackground", () => {
	it("parses a 6-digit hex into RGB channels", () => {
		expect(parseHexBackground(themeWith("#FF8800"))).toEqual({
			r: 255,
			g: 136,
			b: 0,
		});
	});

	it("is case-insensitive", () => {
		expect(parseHexBackground(themeWith("#ff8800"))).toEqual({
			r: 255,
			g: 136,
			b: 0,
		});
	});

	it("returns null for a missing background", () => {
		expect(parseHexBackground(themeWith(undefined))).toBeNull();
	});

	it("returns null for non-6-digit-hex backgrounds", () => {
		expect(parseHexBackground(themeWith("rgba(0, 0, 0, 1)"))).toBeNull();
		expect(parseHexBackground(themeWith("#fff"))).toBeNull();
		expect(parseHexBackground(themeWith("black"))).toBeNull();
	});
});

describe("transparentBg", () => {
	it("preserves the original RGB with alpha 0", () => {
		// Critical: the RGB must survive so xterm's minimumContrastRatio still
		// computes against the theme's intended base colour.
		expect(transparentBg(themeWith("#FF8800")).background).toBe(
			"rgba(255, 136, 0, 0)",
		);
	});

	it("falls back to fully transparent black for non-hex backgrounds", () => {
		expect(transparentBg(themeWith("rgba(1, 2, 3, 1)")).background).toBe(
			"rgba(0, 0, 0, 0)",
		);
		expect(transparentBg(themeWith(undefined)).background).toBe(
			"rgba(0, 0, 0, 0)",
		);
	});

	it("keeps the rest of the theme intact", () => {
		const result = transparentBg(themeWith("#0D1117"));
		expect(result.foreground).toBe("#abcdef");
	});
});

describe("normalFontWeightFor", () => {
	it("returns 'normal' for dark theme backgrounds", () => {
		// e.g. Abundio Dark (#0D1117), Dracula (#282A36), Nord (#2E3440)
		expect(normalFontWeightFor(themeWith("#0D1117"))).toBe("normal");
		expect(normalFontWeightFor(themeWith("#282A36"))).toBe("normal");
		expect(normalFontWeightFor(themeWith("#2E3440"))).toBe("normal");
	});

	it("returns 500 for light theme backgrounds", () => {
		// e.g. white, Catppuccin Latte (#EFF1F5), Solarized Light (#FDF6E3)
		expect(normalFontWeightFor(themeWith("#FFFFFF"))).toBe(500);
		expect(normalFontWeightFor(themeWith("#EFF1F5"))).toBe(500);
		expect(normalFontWeightFor(themeWith("#FDF6E3"))).toBe(500);
	});

	it("switches at the luminance threshold (>140)", () => {
		// Grey #8B8B8B → luma 139 (≤140) stays normal; #8D8D8D → luma 141 lifts.
		expect(normalFontWeightFor(themeWith("#8B8B8B"))).toBe("normal");
		expect(normalFontWeightFor(themeWith("#8D8D8D"))).toBe(500);
	});

	it("falls back to 'normal' for non-hex backgrounds", () => {
		expect(normalFontWeightFor(themeWith("rgba(255, 255, 255, 1)"))).toBe(
			"normal",
		);
		expect(normalFontWeightFor(themeWith(undefined))).toBe("normal");
	});
});
