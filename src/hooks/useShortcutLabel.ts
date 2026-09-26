import {
	formatChord,
	hasOverride,
	type KeybindingOverrides,
} from "../lib/chords";
import { effectiveChord, type KeyAction } from "../lib/keybindings";
import { isMac } from "../lib/platform";
import { useSettingsStore } from "../stores/settingsStore";

/** How a Shortcut is spelled right now: its Override or default, for this
 *  platform. Empty when Unbound, so a caller shows no hint at all. */
export function shortcutLabelFor(
	action: KeyAction,
	overrides: KeybindingOverrides,
): string {
	const chord = effectiveChord(action, overrides);
	return chord ? formatChord(chord, isMac) : "";
}

/** `"Title (⇧⌘G)"`, or just `"Title"` when the Shortcut is Unbound. */
export function withShortcut(title: string, label: string): string {
	return label ? `${title} (${label})` : title;
}

/** The live spelling of an app Shortcut; follows rebinds in every Window. */
export function useShortcutLabel(action: KeyAction): string {
	const overrides = useSettingsStore((s) => s.keybindingOverrides);
	return shortcutLabelFor(action, overrides);
}

/** The Override map, for components that spell several Shortcuts. */
export function useKeybindingOverrides(): KeybindingOverrides {
	return useSettingsStore((s) => s.keybindingOverrides);
}

/** An editor action's spelling: its Override if the user set one, else the
 *  caller's `fallback` (Monaco's default, which only Monaco knows). */
export function editorShortcutLabelFor(
	monacoActionId: string,
	fallback: string,
	overrides: KeybindingOverrides,
): string {
	const id = `editor:${monacoActionId}`;
	if (!hasOverride(overrides, id)) return fallback;
	const chord = overrides[id];
	return chord ? formatChord(chord, isMac) : "";
}
