import { useEffect } from "react";
import {
	checkIntervalMs,
	FOCUS_STALE_MS,
	isDue,
	lastCheckedMs,
} from "../lib/incomingCommits";
import { checkIncoming } from "../lib/pull";
import { addWindowFocusListener, isAppWindowFocused } from "../lib/windowFocus";
import { useIncomingStore } from "../stores/incomingStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";

/** How often the timer looks at whether a check is due. Each Workspace's own
 *  last check decides; this only bounds how late a due check runs. */
const TICK_MS = 60 * 1000;

/** Opened workspaces with an Upstream whose last check is older than
 *  `maxAgeMs`. A Worktree set's members are all listed: Rust fetches the
 *  repository once and hands the others the same result. */
function dueWorkspaces(maxAgeMs: number): string[] {
	const opened = usePtyActivityStore.getState().openedWorkspaceIds;
	const { upstreamById, lastAttemptById } = useIncomingStore.getState();
	const now = Date.now();
	const due: string[] = [];
	for (const id of opened) {
		const u = upstreamById[id];
		if (!u) continue; // no bundle yet, or no Upstream
		if (isDue(lastCheckedMs(lastAttemptById[id], u), now, maxAgeMs)) {
			due.push(id);
		}
	}
	return due;
}

/** Background fetches for **Incoming commits** (ADR-0066): on a timer, and
 *  when the Window gains focus after a while. Off in Settings stops both. */
export function useIncomingSync() {
	const minutes = useSettingsStore((s) => s.incomingCheckMinutes);

	useEffect(() => {
		if (minutes <= 0) return;
		const run = (maxAgeMs: number | null) => {
			if (maxAgeMs === null) return;
			for (const id of dueWorkspaces(maxAgeMs)) {
				void checkIncoming(id, { background: true });
			}
		};
		const tick = () => run(checkIntervalMs(minutes, isAppWindowFocused()));
		const timer = setInterval(tick, TICK_MS);
		const offFocus = addWindowFocusListener((focused) => {
			if (focused) run(FOCUS_STALE_MS);
		});
		return () => {
			clearInterval(timer);
			offFocus();
		};
	}, [minutes]);
}
