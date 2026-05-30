import type { ThemeVariant } from "./themes";

/**
 * The user's global markdown-preview color preference (see ADR-0013).
 *
 * - `"auto"` — follow the active app theme's variant (a dark theme yields a dark
 *   preview, a light theme a white "printed paper" preview). This is the default.
 * - `"light"` — forced pure-white "printed paper" look regardless of theme.
 *
 * There is no forced-*dark* value: dark previews arise only via a dark theme.
 */
export type PreviewColorMode = "auto" | "light";

/**
 * Resolve the preference + active theme variant into the concrete mode the
 * preview should render in. In `"auto"` we mirror the theme's variant; an
 * explicit `"light"` always wins.
 */
export function resolvePreviewColorMode(
	mode: PreviewColorMode,
	themeVariant: ThemeVariant,
): ThemeVariant {
	return mode === "light" ? "light" : themeVariant;
}

/**
 * The next value when the title-bar toggle is clicked. A true binary that can
 * always return to `"auto"` — no pinned-forever dead end (ADR-0013).
 */
export function nextPreviewColorMode(mode: PreviewColorMode): PreviewColorMode {
	return mode === "auto" ? "light" : "auto";
}
