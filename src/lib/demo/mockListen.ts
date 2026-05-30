/**
 * Demo-mode replacement for Tauri's `listen`. Serves the events the UI needs:
 *  - `pty-output-<id>` / `pty-status-<id>` — replayed from the bus, published
 *    by `mockInvoke` on `pty_spawn` (so a pane's transcript renders).
 *  - `git-state-<workspaceId>` — a one-shot bundle push (the git panel renders
 *    from this, not from a one-shot fetch).
 *  - `app-metrics` — a single fixture sample so the status bar isn't blank.
 * Every other channel (`fs-change`, `git-change`, `search-progress-*`, …)
 * produces no events. All return a no-op unlisten.
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { GitStateEvent } from "../ipc";
import type { AppMetrics } from "../types";
import * as fixtures from "./fixtures";
import { subscribe } from "./mockBus";

const noop: UnlistenFn = () => {};

const APP_METRICS: AppMetrics = {
	cpuPercent: 18,
	memoryUsedBytes: 11_300_000_000,
	memoryTotalBytes: 34_359_738_368,
};

export function mockListen<T>(
	event: string,
	cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
	if (event.startsWith("git-state-")) {
		const workspaceId = event.slice("git-state-".length);
		const cwd = fixtures.workspaceRoots[workspaceId];
		if (cwd) {
			const payload: GitStateEvent = fixtures.nonGitRoots.has(cwd)
				? { kind: "error", message: "not a git repository", notGitRepo: true }
				: { kind: "bundle", bundle: fixtures.gitBundleForCwd(cwd) };
			queueMicrotask(() => cb({ payload: payload as T }));
		} else {
			// No fixture root for this workspace — the listener never fires, which
			// would otherwise look like a hung git panel. Flag it for contributors.
			console.warn(`[demo] no fixture root for git-state-${workspaceId}`);
		}
		return Promise.resolve(noop);
	}

	if (event.startsWith("pty-")) {
		return Promise.resolve(
			subscribe(event, (payload) => cb({ payload: payload as T })),
		);
	}

	if (event === "app-metrics") {
		queueMicrotask(() => cb({ payload: APP_METRICS as T }));
		return Promise.resolve(noop);
	}

	return Promise.resolve(noop);
}
