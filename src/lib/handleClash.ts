import { handleKey, handlesIn } from "./agentHandle";
import { parseTabLayout } from "./paneTree";
import type { Tab } from "./types";

interface Backed {
	tabs: readonly Tab[];
	/** A Joined profile's Host; absent for the Window's own Profile. */
	joined?: { hostId: string };
}

/**
 * The panes of Joined profiles whose **Agent handle** another Agent in the
 * Window shares, on another backend (docs/plans/remote-hosts.md phase 10):
 * handles are unique per Profile, so a Joined profile's "Agent Two" may meet
 * this Window's own. Those read `Agent Two @ build-box`; this Window's own
 * Agents keep their plain handle.
 */
export function clashingJoinedPanes(
	workspaces: readonly Backed[],
): Set<string> {
	const byKey = new Map<string, { paneId: string; backend: string }[]>();
	for (const ws of workspaces) {
		const backend = ws.joined?.hostId ?? "";
		for (const tab of ws.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (!layout) continue;
			handlesIn(layout, (handle, paneId) => {
				const key = handleKey(handle);
				const list = byKey.get(key) ?? [];
				list.push({ paneId, backend });
				byKey.set(key, list);
			});
		}
	}
	const out = new Set<string>();
	for (const list of byKey.values()) {
		if (new Set(list.map((e) => e.backend)).size < 2) continue;
		for (const e of list) if (e.backend) out.add(e.paneId);
	}
	return out;
}

let last: readonly Backed[] | null = null;
let lastSet = new Set<string>();

/** `clashingJoinedPanes`, kept while the Workspace list is unchanged. */
export function clashingJoinedPanesCached(
	workspaces: readonly Backed[],
): Set<string> {
	if (workspaces !== last) {
		last = workspaces;
		lastSet = clashingJoinedPanes(workspaces);
	}
	return lastSet;
}
