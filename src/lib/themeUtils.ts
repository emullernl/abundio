import type { FontWeight, ITheme } from "@xterm/xterm";

/**
 * Parse a theme's background colour as a 6-digit hex (`#rrggbb`) into its RGB
 * channels. Returns null for a missing or non-6-digit-hex background (e.g. an
 * `rgba(...)` string or a named colour), letting callers fall back.
 */
export function parseHexBackground(
	theme: ITheme,
): { r: number; g: number; b: number } | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(theme.background ?? "");
	if (!hex) return null;
	const n = Number.parseInt(hex[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Return a copy of the theme with its background made fully transparent, so the
 * workspace's ambient gradient shows through the pane. Cells painted with the
 * default background become see-through; cells with explicit ANSI bg colors stay
 * opaque. The original RGB is preserved (alpha → 0) so xterm's
 * minimumContrastRatio still computes against the theme's intended base colour.
 * Requires the Terminal to be created with `allowTransparency: true`.
 */
export function transparentBg(theme: ITheme): ITheme {
	const rgb = parseHexBackground(theme);
	if (!rgb) return { ...theme, background: "rgba(0, 0, 0, 0)" };
	return { ...theme, background: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)` };
}

/**
 * Normal-text font weight for a theme. Light text on a dark background reads
 * heavier than dark text on a light background at the same weight (irradiation),
 * so dark themes already *look* bold at xterm's default weight while light themes
 * look thin. We lift the normal weight on light themes so they match that bolder
 * dark-theme appearance. Bold ANSI text keeps the default bold weight (700), so
 * the normal/bold distinction is preserved (500 vs 700). Light vs dark is derived
 * from the theme's background luminance so callers don't need to thread variant.
 */
export function normalFontWeightFor(theme: ITheme): FontWeight {
	const rgb = parseHexBackground(theme);
	if (!rgb) return "normal";
	// Perceived luminance (Rec. 601); > 140/255 → a light background.
	const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
	return luma > 140 ? 500 : "normal";
}
