/**
 * Seed a pane's activity (status-dot) state into `ptyActivityStore`. Shared by
 * two call sites:
 *  - `mockInvoke` on `pty_spawn` — keyed by the real generated ptyId.
 *  - `useDemoBootstrap` at launch — keyed by a synthetic `demo-<paneId>` id so
 *    every opened workspace's dots are visible immediately, before the user
 *    navigates to the pane and triggers a real spawn (which then re-seeds the
 *    real ptyId; the synthetic entry is harmlessly orphaned).
 */
import {
	setShellCommandRunning,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import type { DemoPaneSpec } from "./fixtures";

export function seedPaneActivity(
	ptyId: string,
	paneId: string,
	spec: DemoPaneSpec,
): void {
	const store = usePtyActivityStore.getState();
	store.registerPane(paneId, ptyId);
	store.initPty(ptyId, spec.mode);
	if (spec.agentId) store.setAgentPty(ptyId, spec.agentId);

	if (spec.mode === "agent") {
		if (spec.state !== "idle") store.applyHookEvent(ptyId, spec.state);
	} else if (spec.state === "active") {
		// Hold the shell "active" (cyan) stably: both markIdle and the idle
		// scanner skip a pane with shellCommandRunning set.
		setShellCommandRunning(ptyId, true);
		store.recordOutput(ptyId);
	}
}
