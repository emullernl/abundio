import { useMemo } from "react";
import { parseTabLayout } from "../lib/paneTree";
import type { PaneNode } from "../lib/types";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * The active tab's pane tree, as a **reactive, reference-stable** value.
 *
 * Do not reach for `useWorkspaceStore((s) => s.getActiveLayout())`: that getter
 * parses `layoutJson` (and falls back to `defaultLayout()`, which mints a fresh
 * uuid), so it returns a new object on every call. As a zustand selector that
 * is a new reference every render — an infinite render loop, not a stale value.
 *
 * Subscribing to the JSON *string* instead gives a primitive that only changes
 * when the layout really does, and the parse is memoised on it.
 */
export function useActiveLayout(): PaneNode | null {
	const layoutJson = useWorkspaceStore(
		(s) => s.getActiveTab()?.layoutJson ?? null,
	);
	return useMemo(
		() => (layoutJson ? parseTabLayout(layoutJson) : null),
		[layoutJson],
	);
}
