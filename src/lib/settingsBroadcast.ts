import {
	PERSISTED_KEYS,
	type PersistedSettingKey,
} from "../stores/settingsStore";

/**
 * Persisted settings that are deliberately NOT broadcast to other Windows.
 *
 * `settingsStore` *is* the global store by construction — per-Window state
 * lives in `windowUiStore` (ADR-0007/0008) — so these exclusions are about
 * noise, not scope:
 *
 * - the three widths are written continuously during a sidebar drag; they are
 *   global (CONTEXT.md), but broadcasting them would live-resize your other
 *   Windows mid-drag when last-drag-wins-on-next-open is the intent;
 * - `activityByteThreshold` is written at high frequency by the meter overlay;
 * - `lastOpenedDevEnvId` is a write-on-use breadcrumb, not a preference.
 *
 * Everything else in `PERSISTED_KEYS` propagates. Adding a setting to the store
 * requires no change here — that is the point.
 */
export const NOT_BROADCAST = new Set<PersistedSettingKey>([
	"sidebarWidth",
	"rightSidebarWidth",
	"rightSidebarPrRatio",
	"activityByteThreshold",
	"lastOpenedDevEnvId",
]);

/** The persisted keys that DO cross Window boundaries, in `PERSISTED_KEYS` order. */
export const BROADCAST_KEYS: readonly PersistedSettingKey[] =
	PERSISTED_KEYS.filter((key) => !NOT_BROADCAST.has(key));

/**
 * Project any settings-shaped object onto the broadcast slice.
 *
 * Used on both sides of the bridge: on the publishing side the input is the
 * full store state, on the receiving side it is an event payload that already
 * holds only broadcast keys. Keys absent from the input are omitted rather than
 * emitted as `undefined`, so both sides fingerprint identically.
 */
export function broadcastSliceOf(
	source: Record<string, unknown>,
): Record<string, unknown> {
	const slice: Record<string, unknown> = {};
	for (const key of BROADCAST_KEYS) {
		if (key in source) slice[key] = source[key];
	}
	return slice;
}
