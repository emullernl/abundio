import { useEffect } from "react";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { isDemoMode } from ".";
import { agentPanes, OPEN_ON_LAUNCH, panesByWorkspace } from "./fixtures";
import { seedPaneActivity } from "./seed";

/**
 * In demo mode, open a curated set of workspaces once `loadWorkspaces` has run.
 * `loadWorkspaces` leaves `activeWorkspaceId` null, so without this the app
 * would sit on the empty "select a workspace" state.
 *
 * The first id in `OPEN_ON_LAUNCH` (acme-web) becomes the active workspace; the
 * rest are marked opened so `TerminalPool` spawns their terminals in the
 * background — which fans out the canned transcripts and agent dots across the
 * Overview bar. No-op outside demo mode.
 */
export function useDemoBootstrap(): void {
	useEffect(() => {
		if (!isDemoMode()) return;

		const open = (): boolean => {
			const s = useWorkspaceStore.getState();
			if (!s.workspacesInitialized || s.activeWorkspaceId)
				return s.workspacesInitialized;
			const ids = new Set(s.workspaces.map((w) => w.id));
			const toOpen = OPEN_ON_LAUNCH.filter((id) => ids.has(id));
			const [active, ...background] = toOpen;
			if (!active) return true;

			const activity = usePtyActivityStore.getState();
			for (const id of background) activity.markWorkspaceOpened(id);
			s.beginWorkspaceSwitch(active);

			// Pre-seed status dots for every pane of every opened workspace so the
			// Overview bar, sidebar and tab dots show their variety immediately —
			// without the user having to visit each workspace/tab to spawn its PTY.
			// Real spawns (on first view) re-seed the live ptyId; these synthetic
			// entries are then harmlessly orphaned.
			for (const wsId of toOpen) {
				for (const paneId of panesByWorkspace[wsId] ?? []) {
					const spec = agentPanes[paneId];
					if (spec) seedPaneActivity(`demo-${paneId}`, paneId, spec);
				}
			}
			return true;
		};

		if (open()) return;
		// Assign `unsub` before subscribing so the callback can't observe it as
		// undefined — Zustand doesn't fire synchronously on subscribe today, but
		// this keeps the teardown safe regardless.
		let unsub: (() => void) | null = null;
		unsub = useWorkspaceStore.subscribe(() => {
			if (open() && unsub) {
				unsub();
				unsub = null;
			}
		});
		return () => unsub?.();
	}, []);
}
