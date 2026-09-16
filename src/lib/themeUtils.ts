import type { FontWeight, ITheme } from "@xterm/xterm";

/**
 * How far the **Dim slot** (ANSI colour 8) must sit below the foreground, as a
 * WCAG contrast ratio between the two. The contract itself — what the guard test
 * asserts for every theme.
 *
 * 2 rather than something nearer Vesper's comfortable 2.8: the dim colour has to
 * fit *underneath* the foreground, so on a theme whose foreground is only 4.75:1
 * off the background (Solarized Dark) a wider gap is bought by pushing the
 * suggestion fainter until it starts to disappear. See ADR-0035.
 */
export const DIM_SEPARATION = 2;

/**
 * What a placed Dim slot actually aims for. Slightly over the contract, so that
 * rounding to 8-bit channels cannot drop the result under it.
 */
export const DIM_PLACEMENT = 2.05;

/**
 * The divisor behind the per-theme contrast floor. Slightly over `DIM_PLACEMENT`,
 * so a slot placed at `DIM_PLACEMENT` clears the floor outright and xterm's
 * correction never fires on it. See `contrastFloorFor` for why the three numbers
 * have to differ.
 */
export const DIM_FLOOR_DIVISOR = 2.1;

/** WCAG AA for normal text — the contrast floor a theme gets when it can afford it. */
const MAX_CONTRAST_FLOOR = 4.5;

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
 * Smallest blend of `from` toward `to` that satisfies `ok`, or null when `to`
 * itself does not. Assumes `ok` is monotonic along the blend (it is for every
 * target here). Binary search, 24 steps — finer than 8-bit channels represent.
 */
function blendUntil(from: Rgb, to: Rgb, ok: (c: Rgb) => boolean): Rgb | null {
	if (ok(from)) return from;
	// The endpoint is the best this direction can do. If even that fails, the
	// target is unreachable and the search would otherwise converge on `to` and
	// return it as though it had succeeded — a wrong answer with no signal.
	if (!ok(to)) return null;
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
 * A faithful port of xterm's `rgba.ensureContrastRatio` (`common/Color.ts`) —
 * what the renderer *actually* paints when a cell's fg/bg contrast is under
 * `minimumContrastRatio`.
 *
 * Two details make it worth porting rather than approximating, and both were got
 * wrong the first time:
 *
 * 1. **It steps, it does not solve.** `increaseLuminance`/`reduceLuminance` walk
 *    each channel 10% of its remaining distance per iteration and stop at the
 *    first step *past* the ratio. The result overshoots the floor, away from the
 *    background — i.e. toward the foreground. A minimal-blend model lands on the
 *    floor exactly and so overstates how distinct the corrected colour is.
 * 2. **The direction is relative, not absolute.** xterm goes away from the
 *    background (`fgL < bgL ? reduce : increase`), not "toward white on a dark
 *    theme". The two agree on every built-in palette and diverge for a slot 8
 *    darker than a dark background — where an absolute rule would model a lift
 *    toward white while xterm pushes toward black.
 *
 * When a direction runs out of room without reaching the ratio, xterm tries the
 * other one and keeps whichever got closer. Ported too: that fallback is the
 * mid-tone-background case, where neither endpoint may reach a high floor.
 */
export function xtermEnsureContrast(bg: Rgb, fg: Rgb, ratio: number): Rgb {
	const bgL = relativeLuminance(bg);
	if (contrastRatio(bg, fg) >= ratio) return fg;
	const towardBlack = relativeLuminance(fg) < bgL;
	const first = stepLuminance(bg, fg, ratio, towardBlack);
	if (contrastRatio(bg, first) >= ratio) return first;
	const second = stepLuminance(bg, fg, ratio, !towardBlack);
	return contrastRatio(bg, first) > contrastRatio(bg, second) ? first : second;
}

/** One direction of xterm's walk: 10% of each channel's remaining distance per step. */
function stepLuminance(bg: Rgb, fg: Rgb, ratio: number, down: boolean): Rgb {
	let { r, g, b } = fg;
	const exhausted = () =>
		down ? r <= 0 && g <= 0 && b <= 0 : r >= 255 && g >= 255 && b >= 255;
	while (contrastRatio(bg, { r, g, b }) < ratio && !exhausted()) {
		if (down) {
			r -= Math.max(0, Math.ceil(r * 0.1));
			g -= Math.max(0, Math.ceil(g * 0.1));
			b -= Math.max(0, Math.ceil(b * 0.1));
		} else {
			r = Math.min(255, r + Math.ceil((255 - r) * 0.1));
			g = Math.min(255, g + Math.ceil((255 - g) * 0.1));
			b = Math.min(255, b + Math.ceil((255 - b) * 0.1));
		}
	}
	return { r, g, b };
}

/**
 * The contrast floor for this theme — what xterm's `minimumContrastRatio` is set
 * to. `min(4.5, fgContrast / 2.1)`.
 *
 * A flat 4.5 is a *permanent* floor, reapplied on every paint, so it also
 * governs how dim the **Dim slot** is allowed to be. On a theme whose own
 * foreground barely clears 4.5 that leaves no room underneath to be dim in:
 * Solarized Dark's foreground is 4.75:1, so the floor lifted its slot 8 to
 * within 1.06:1 of the body text and zsh-autosuggestions became invisible as a
 * distinct colour. Themes that can afford the full WCAG floor still get it.
 *
 * The divisor is `DIM_FLOOR_DIVISOR`, not `DIM_SEPARATION`, and the gap between
 * them is the whole point. Contrast ratios multiply along an ordered luminance
 * triple — `cr(fg, c) · cr(c, bg) = fgContrast` — so dividing by exactly
 * `DIM_SEPARATION` would make "at least 2:1 from the foreground" and "at least
 * the floor from the background" meet at a single point, which 8-bit rounding
 * always falls off. A placed slot would land a hair under the floor and be
 * handed straight back to the correction it was written to escape. Dividing by
 * slightly more turns that point into a band. See ADR-0035.
 */
export function contrastFloorFor(theme: ITheme): number {
	const bg = parseHex(theme.background);
	const fg = parseHex(theme.foreground);
	if (!bg || !fg) return MAX_CONTRAST_FLOOR;
	return Math.min(
		MAX_CONTRAST_FLOOR,
		contrastRatio(fg, bg) / DIM_FLOOR_DIVISOR,
	);
}

/**
 * The colour xterm will actually paint slot 8 with: the theme's declared
 * `brightBlack` after the correction above, at this theme's floor.
 *
 * Every check on the Dim slot runs on this, never on the declared value —
 * Solarized Dark declares `#002B36`, a healthy 4.75:1 from its foreground, and
 * only collapses once the correction has lifted it.
 */
export function effectiveDimColor(theme: ITheme, floor: number): Rgb | null {
	const bg = parseHex(theme.background);
	const dim = parseHex(theme.brightBlack);
	if (!bg || !dim) return null;
	return xtermEnsureContrast(bg, dim, floor);
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
	if (contrastRatio(fg, dim) < DIM_SEPARATION) return false;
	const [lbg, lfg, ldim] = [bg, fg, dim].map(relativeLuminance);
	return lbg < lfg ? ldim < lfg : ldim > lfg;
}

/**
 * A replacement `brightBlack` for a theme whose slot 8 does not recede, or null
 * to keep the theme's own value.
 *
 * **The floor never places the Dim slot; it only guards it.** Letting the
 * correction do the placing was the first design here and it does not survive
 * contact with the real algorithm: the walk overshoots by however much a 10%
 * step happens to carry it, so a theme rescued that way lands at an arbitrary
 * separation — Solarized Dark at ~1.59:1, not the 2.00 a minimal-blend model
 * predicts. So any theme that fails the contract gets an explicit colour placed
 * at `DIM_PLACEMENT`, chosen to clear its floor outright so the correction never
 * fires on slot 8 at all.
 *
 * The placement preserves the declared colour's hue: it blends it toward white
 * or black until it reaches the target *luminance*, which is always reachable —
 * unlike a walk toward the background, which for an inverted slot like Solarized
 * Light's has to pass through the foreground first.
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

	// Place it DIM_PLACEMENT:1 off the foreground. Ratios multiply along the
	// ordered triple, so that fixes its distance from the background too — at
	// fgContrast / DIM_PLACEMENT, comfortably above the floor's
	// fgContrast / DIM_FLOOR_DIVISOR.
	const lbg = relativeLuminance(bg);
	const toBg = contrastRatio(fg, bg) / DIM_PLACEMENT;
	const targetL =
		lbg < relativeLuminance(fg)
			? toBg * (lbg + 0.05) - 0.05
			: (lbg + 0.05) / toBg - 0.05;

	const toward: Rgb =
		targetL > relativeLuminance(dim)
			? { r: 255, g: 255, b: 255 }
			: { r: 0, g: 0, b: 0 };
	const placed = blendUntil(dim, toward, (c) =>
		targetL > relativeLuminance(dim)
			? relativeLuminance(c) >= targetL
			: relativeLuminance(c) <= targetL,
	);
	return placed ? toHex(placed) : null;
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
