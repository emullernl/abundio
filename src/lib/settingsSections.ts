/**
 * The Settings window's navigation vocabulary.
 *
 * Section ids cross the Rust→JS boundary — `open_settings_window { section }`
 * encodes one into the window URL on a cold open and emits it as a
 * `settings-set-section` event when the window is already open — so they are
 * vocabulary, not an implementation detail. See CONTEXT.md.
 *
 * This is a pure module rather than a store on purpose: the Settings window is
 * its own webview (ADR-0008), so a value written to a zustand store in a
 * Profile-bound Window is invisible here. Only what rides the URL or a Tauri
 * event can cross.
 */

export const SETTINGS_SECTIONS = [
	"theme",
	"fonts",
	"terminal",
	"editor",
	"agents",
	"profiles",
	"github",
	"updates",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Where Cmd+, lands when no section is requested. */
export const DEFAULT_SECTION: SettingsSection = "theme";

/**
 * The nav rail: group captions over leaf pages.
 *
 * Captions are presentation only — they are not addressable, have no page of
 * their own, and are not focusable. Only the leaves are sections.
 */
export const SETTINGS_NAV: ReadonlyArray<{
	caption: string;
	items: ReadonlyArray<{ id: SettingsSection; label: string }>;
}> = [
	{
		caption: "Appearance",
		items: [
			{ id: "theme", label: "Theme" },
			{ id: "fonts", label: "Fonts" },
		],
	},
	{
		caption: "Panes",
		items: [
			{ id: "terminal", label: "Terminal" },
			{ id: "editor", label: "Editor" },
		],
	},
	{
		caption: "Application",
		items: [
			{ id: "agents", label: "Agents" },
			{ id: "profiles", label: "Profiles" },
			{ id: "github", label: "GitHub" },
			{ id: "updates", label: "Updates" },
		],
	},
];

/**
 * Pre-reorganisation ids, still reachable from a stale URL or an older build's
 * menu item. `theme`, `agents`, `profiles`, `github` and `updates` survived the
 * regroup verbatim and need no alias.
 */
const LEGACY_ALIASES: Record<string, SettingsSection> = {
	"terminal-font": "fonts",
	"ui-font": "fonts",
	shell: "terminal",
};

const KNOWN = new Set<string>(SETTINGS_SECTIONS);

/** Resolve an untrusted section string, or null if it names nothing. */
export function normalizeSection(
	raw: string | null | undefined,
): SettingsSection | null {
	if (!raw) return null;
	if (KNOWN.has(raw)) return raw as SettingsSection;
	return LEGACY_ALIASES[raw] ?? null;
}

/**
 * The section a freshly-opened Settings window should show.
 *
 * `search` is a parameter rather than a read of `window.location` so this stays
 * pure and testable.
 */
export function initialSection(search: string): SettingsSection {
	try {
		return (
			normalizeSection(new URLSearchParams(search).get("section")) ??
			DEFAULT_SECTION
		);
	} catch {
		return DEFAULT_SECTION;
	}
}
