import type { ITheme } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { themes } from "../themes";
import {
	contrastFloorFor,
	contrastRatio,
	DIM_SEPARATION,
	DIM_SEPARATION_TOLERANCE,
	dimColorOverrideFor,
	dimSlotRecedes,
	effectiveDimColor,
	normalFontWeightFor,
	parseHexBackground,
	relativeLuminance,
	terminalThemeFor,
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

/** RGB for a hex literal written in a test — these are always parseable. */
const rgb = (hex: string) => {
	const parsed = parseHexBackground({ background: hex });
	if (!parsed) throw new Error(`unparseable test colour: ${hex}`);
	return parsed;
};

describe("contrastFloorFor", () => {
	it("keeps the full WCAG 4.5 floor on themes that can afford it", () => {
		// Vesper's foreground is 12.59:1 — 12.59 / 2 clamps to 4.5.
		expect(contrastFloorFor(themes.vesper.terminal)).toBe(4.5);
		expect(contrastFloorFor(themes.default.terminal)).toBe(4.5);
	});

	it("lowers the floor on a low-contrast theme", () => {
		// Solarized Dark's foreground is only 4.75:1 off its background, so a flat
		// 4.5 floor leaves no room underneath for a dim colour. 4.75 / 2 ≈ 2.37.
		expect(contrastFloorFor(themes.solarizedDark.terminal)).toBeCloseTo(
			2.37,
			1,
		);
	});

	it("falls back to 4.5 when the colours are not 6-digit hex", () => {
		expect(contrastFloorFor({ background: "black", foreground: "#fff" })).toBe(
			4.5,
		);
		expect(contrastFloorFor({ background: "#000000" })).toBe(4.5);
	});
});

describe("effectiveDimColor", () => {
	it("leaves a slot that already clears the floor untouched", () => {
		// Abundio Light's #57606A is 6.39:1 against white, comfortably over its
		// 4.5 floor. (Vesper's is 4.50:1 — exactly on it, so it is not a witness
		// for "untouched": xterm nudges a hair there and so do we.)
		const theme = themes.abundioLight.terminal;
		expect(effectiveDimColor(theme, contrastFloorFor(theme))).toEqual(
			rgb("#57606A"),
		);
	});

	it("lifts a slot that falls under the floor, as xterm would", () => {
		// Solarized Dark declares brightBlack === its background (1.00:1).
		const theme = themes.solarizedDark.terminal;
		const lifted = effectiveDimColor(theme, 4.5);
		expect(lifted).not.toBeNull();
		if (!lifted) return;
		expect(contrastRatio(lifted, rgb("#002B36"))).toBeCloseTo(4.5, 1);
	});
});

describe("dimSlotRecedes", () => {
	it("is false for the bug this was written for", () => {
		// Solarized Dark under the old flat 4.5 floor: the lifted slot lands 1.06:1
		// from the foreground — the same colour as the command being typed.
		expect(dimSlotRecedes(themes.solarizedDark.terminal, 4.5)).toBe(false);
	});

	it("rejects an inverted slot that passes on ratio alone", () => {
		// Solarized Light's brightBlack is near-black: a healthy 3.37:1 from the
		// foreground, and heavier than it. Direction is half the rule.
		const theme = themes.solarizedLight.terminal;
		const dim = effectiveDimColor(theme, contrastFloorFor(theme));
		expect(dim).not.toBeNull();
		if (!dim) return;
		expect(contrastRatio(dim, rgb("#657B83"))).toBeGreaterThan(2);
		expect(dimSlotRecedes(theme, contrastFloorFor(theme))).toBe(false);
	});

	it("passes unparseable themes rather than overriding blindly", () => {
		expect(dimSlotRecedes({ background: "black" }, 4.5)).toBe(true);
	});
});

describe("dimColorOverrideFor", () => {
	it("leaves 17 of the 19 built-in palettes byte-for-byte", () => {
		const overridden = Object.values(themes)
			.filter((t) => dimColorOverrideFor(t.terminal) !== null)
			.map((t) => t.name);
		expect(overridden.sort()).toEqual(["catppuccinLatte", "solarizedLight"]);
	});

	it("walks the declared colour toward the background, keeping its hue", () => {
		expect(dimColorOverrideFor(themes.catppuccinLatte.terminal)).toBe(
			"#7c7f92",
		);
		expect(dimColorOverrideFor(themes.solarizedLight.terminal)).toBe("#a6b1a8");
	});
});

describe("terminalThemeFor", () => {
	it("carries the contrast floor and weight alongside the palette", () => {
		const derived = terminalThemeFor(themes.solarizedDark.terminal);
		expect(derived.minimumContrastRatio).toBeCloseTo(2.37, 1);
		expect(derived.fontWeight).toBe("normal");
		expect(derived.theme.background).toBe("rgba(0, 43, 54, 0)");
	});

	it("applies the Dim slot override to the palette it hands out", () => {
		expect(
			terminalThemeFor(themes.solarizedLight.terminal).theme.brightBlack,
		).toBe("#a6b1a8");
	});
});

// The contract, enforced across every built-in theme. This is what stops the bug
// coming back: a theme added later with a plausible-looking brightBlack cannot
// reintroduce it, because the check runs on the *effective* colour — declared
// value, then contrast floor applied — not on the hex code in themes.ts.
describe("every built-in theme has a usable Dim slot", () => {
	for (const theme of Object.values(themes)) {
		it(`${theme.displayName}`, () => {
			const { theme: painted, minimumContrastRatio } = terminalThemeFor(
				theme.terminal,
			);
			const bg = rgb(theme.terminal.background as string);
			const fg = rgb(theme.terminal.foreground as string);
			const dim = effectiveDimColor(
				{ ...theme.terminal, brightBlack: painted.brightBlack },
				minimumContrastRatio,
			);
			expect(dim).not.toBeNull();
			if (!dim) return;

			// Distinguishable from the text the user typed. The contract's own
			// tolerance, not a fudge for this assertion — see DIM_SEPARATION_TOLERANCE.
			expect(contrastRatio(fg, dim)).toBeGreaterThanOrEqual(
				DIM_SEPARATION - DIM_SEPARATION_TOLERANCE,
			);

			// And dim, not merely different: nearer the background than the text is.
			const [lbg, lfg, ldim] = [bg, fg, dim].map(relativeLuminance);
			if (lbg < lfg) expect(ldim).toBeLessThan(lfg);
			else expect(ldim).toBeGreaterThan(lfg);
		});
	}
});
