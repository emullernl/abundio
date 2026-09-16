import type { FontWeight, ITheme } from "@xterm/xterm";

/**
 * How far the **Dim slot** (ANSI colour 8) must sit below the foreground, as a
 * WCAG contrast ratio between the two. Also the divisor that produces the
 * per-theme contrast floor: a floor of `fgContrast / DIM_SEPARATION` is exactly
 * what leaves a lifted slot 8 this far under the body text.
 *
 * 2 rather than something nearer Vesper's comfortable 2.8: the dim colour has to
 * fit *underneath* the foreground, so on a theme whose foreground is only 4.75:1
 * off the background (Solarized Dark) a wider gap is bought by pushing the
 * suggestion fainter until it starts to disappear. See ADR-0035.
 */
export const DIM_SEPARATION = 2;

/** WCAG AA for normal text — the contrast floor a theme gets when it can afford it. */
const MAX_CONTRAST_FLOOR = 4.5;

/**
 * Slack on the `DIM_SEPARATION` check.
 *
 * Not defensive rounding — the boundary is where most themes *land*. Contrast
 * ratios along an ordered luminance triple multiply exactly, so a theme whose
 * slot 8 is held up by the floor sits at `fgContrast / floor` from the
 * foreground, and `floor` is `fgContrast / DIM_SEPARATION` by construction:
 * exactly 2, approached from below by the search and then rounded to 8-bit
 * channels. Without the slack, six of nineteen themes fail their own rule by a
 * few thousandths and are handed an override they do not need.
 */
export const DIM_SEPARATION_TOLERANCE = 0.02;

type Rgb = { r: number; g: number; b: number };

/** Parse any 6-digit hex (`#rrggbb`) into RGB channels, or null. */
function parseHex(value: string | undefined): Rgb | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(value ?? "");
	if (!hex) return null;
	const n = Number.parseInt(hex[1], 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = ({ r, g, b }: Rgb): string =>
	`#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
	const [lr, lg, lb] = [r, g, b].map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio between two colours (1–21, order-independent). */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const mix = (from: Rgb, to: Rgb, t: number): Rgb => ({
	// Rounded to whole channels: these colours end up as 6-digit hex in the
	// palette, so the search must work in the space the result lives in.
	r: Math.round(from.r + (to.r - from.r) * t),
	g: Math.round(from.g + (to.g - from.g) * t),
	b: Math.round(from.b + (to.b - from.b) * t),
});

/**
 * Smallest blend of `from` toward `to` that satisfies `ok`, assuming `ok` is
 * monotonic along the blend (it is for every contrast target here). Binary
 * search, 24 steps — finer than 8-bit channels can represent.
 */
function blendUntil(from: Rgb, to: Rgb, ok: (c: Rgb) => boolean): Rgb {
	if (ok(from)) return from;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (ok(mix(from, to, mid))) hi = mid;
		else lo = mid;
	}
	return mix(from, to, hi);
}

/**
 * Parse a theme's background colour as a 6-digit hex (`#rrggbb`) into its RGB
 * channels. Returns null for a missing or non-6-digit-hex background (e.g. an
 * `rgba(...)` string or a named colour), letting callers fall back.
 */
export function parseHexBackground(theme: ITheme): Rgb | null {
	return parseHex(theme.background);
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

/**
 * The contrast floor for this theme — what xterm's `minimumContrastRatio` is set
 * to. `min(4.5, fgContrast / 2)`.
 *
 * A flat 4.5 is a *permanent* floor, reapplied on every paint, so it also
 * governs how dim the **Dim slot** is allowed to be. On a theme whose own
 * foreground barely clears 4.5 that leaves no room underneath to be dim in:
 * Solarized Dark's foreground is 4.75:1, so the floor lifted its slot 8 to
 * within 1.06:1 of the body text and zsh-autosuggestions became invisible as a
 * distinct colour. Themes that can afford the full WCAG floor still get it.
 * See ADR-0035.
 */
export function contrastFloorFor(theme: ITheme): number {
	const bg = parseHex(theme.background);
	const fg = parseHex(theme.foreground);
	if (!bg || !fg) return MAX_CONTRAST_FLOOR;
	return Math.min(MAX_CONTRAST_FLOOR, contrastRatio(fg, bg) / DIM_SEPARATION);
}

/**
 * The colour xterm will actually paint slot 8 with: the theme's declared
 * `brightBlack`, lifted toward white (dark theme) or black (light theme) if it
 * falls under `floor`, exactly as xterm's contrast correction does.
 *
 * Every check on the Dim slot runs on this, never on the declared value —
 * Solarized Dark declares `#002B36`, a healthy 4.75:1 from its foreground, and
 * only collapses once the floor has lifted it.
 */
export function effectiveDimColor(theme: ITheme, floor: number): Rgb | null {
	const bg = parseHex(theme.background);
	const dim = parseHex(theme.brightBlack);
	if (!bg || !dim) return null;
	const toward: Rgb =
		relativeLuminance(bg) < 0.5
			? { r: 255, g: 255, b: 255 }
			: { r: 0, g: 0, b: 0 };
	return blendUntil(dim, toward, (c) => contrastRatio(bg, c) >= floor);
}

/**
 * Does this theme's Dim slot recede? It must sit between the background and the
 * foreground in luminance, nearer the background, and at least
 * `DIM_SEPARATION`:1 from the foreground.
 *
 * Direction is half the rule, not decoration on the ratio. Solarized Light
 * declares slot 8 as near-black `#002B36` — 3.37:1 from its foreground, passing
 * any ratio test, and reading as *emphasis*: the suggestion shouts louder than
 * the command.
 */
export function dimSlotRecedes(theme: ITheme, floor: number): boolean {
	const bg = parseHex(theme.background);
	const fg = parseHex(theme.foreground);
	const dim = effectiveDimColor(theme, floor);
	if (!bg || !fg || !dim) return true;
	if (contrastRatio(fg, dim) < DIM_SEPARATION - DIM_SEPARATION_TOLERANCE)
		return false;
	const [lbg, lfg, ldim] = [bg, fg, dim].map(relativeLuminance);
	return lbg < lfg ? ldim < lfg : ldim > lfg;
}

/**
 * A replacement `brightBlack` for a theme whose declared slot 8 cannot recede
 * even at this theme's floor, or null to keep the theme's own value.
 *
 * Only reachable where the floor is not the binding constraint — i.e. the
 * declared colour already clears the floor and is still too close to (or heavier
 * than) the foreground. Of the built-in themes that is Catppuccin Latte
 * (`#6C6F85`, 1.62:1 from its foreground) and Solarized Light (`#002B36`,
 * inverted). The fix walks the declared colour toward the background until it is
 * `DIM_SEPARATION`:1 from the foreground, which preserves its hue.
 *
 * The result needs no further protection from the floor: contrast ratios along
 * an ordered luminance triple multiply exactly, so a colour sitting
 * `fgContrast / DIM_SEPARATION` from the foreground sits `fgContrast /
 * DIM_SEPARATION` from the background — which is the floor. It lands on it.
 *
 * Note this also changes colour 8 used as a *background* — xterm has one slot for
 * both roles and no way to split them. See ADR-0035.
 */
export function dimColorOverrideFor(theme: ITheme): string | null {
	const floor = contrastFloorFor(theme);
	if (dimSlotRecedes(theme, floor)) return null;
	const bg = parseHex(theme.background);
	const fg = parseHex(theme.foreground);
	const dim = parseHex(theme.brightBlack);
	if (!bg || !fg || !dim) return null;
	// The predicate carries *both* halves of the rule, not just the ratio. Walking
	// Solarized Light's near-black slot toward its cream background passes through
	// the foreground on the way, and a ratio-only predicate is satisfied before it
	// sets off — colour 8 is already 3.37:1 from the foreground, on the wrong side
	// of it. Only points past the foreground, on the background's side, count.
	const lfg = relativeLuminance(fg);
	const recedes = (c: Rgb) =>
		relativeLuminance(bg) < lfg
			? relativeLuminance(c) < lfg
			: relativeLuminance(c) > lfg;
	return toHex(
		blendUntil(
			dim,
			bg,
			(c) => recedes(c) && contrastRatio(fg, c) >= DIM_SEPARATION,
		),
	);
}

/**
 * Every terminal option derived from the active theme, as one object to spread.
 *
 * One seam rather than a helper per setting: the looser shape had already failed
 * once — `minimumContrastRatio` was set at Terminal construction and never added
 * to `setAllTerminalsTheme`, harmless only while it was a constant. Now that it
 * varies by theme, a live switch would otherwise carry the old theme's floor.
 */
export function terminalThemeFor(theme: ITheme): {
	theme: ITheme;
	fontWeight: FontWeight;
	minimumContrastRatio: number;
} {
	const override = dimColorOverrideFor(theme);
	const corrected = override ? { ...theme, brightBlack: override } : theme;
	return {
		theme: transparentBg(corrected),
		fontWeight: normalFontWeightFor(corrected),
		minimumContrastRatio: contrastFloorFor(corrected),
	};
}
