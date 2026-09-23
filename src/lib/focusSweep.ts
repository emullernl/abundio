import { create } from "zustand";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * The **Focus sweep** trigger rule. A sweep plays whenever the Focused pane
 * changes to a *different* Pane, whatever caused it — except the first focus
 * after the Window opens, when every Pane is appearing at once and a sweep is
 * noise. Re-focusing the already-focused Pane changes nothing, so it never
 * sweeps; neither does the Window regaining OS focus, for the same reason.
 */
export function shouldSweep(
	prev: string | null,
	next: string | null,
	hasFocusedBefore: boolean,
	enabled: boolean,
): boolean {
	return enabled && hasFocusedBefore && next !== null && next !== prev;
}

interface FocusSweepState {
	/** The Pane currently sweeping, or null. Only one at a time: a new sweep
	 *  replaces the old, which is how a sweep in flight is cut short. */
	paneId: string | null;
	/** Bumped per sweep, so a Pane swept twice in a row restarts its animation. */
	nonce: number;
	/** Clear the sweep that just finished — unless a newer one replaced it. */
	finish: (nonce: number) => void;
}

export const useFocusSweepStore = create<FocusSweepState>((set) => ({
	paneId: null,
	nonce: 0,
	finish: (nonce) => set((s) => (s.nonce === nonce ? { paneId: null } : s)),
}));

/** Feed Focused-pane changes into the sweep store. Returns the unsubscribe. */
export function installFocusSweep(): () => void {
	let hasFocusedBefore = useWorkspaceStore.getState().focusedPaneId !== null;
	return useWorkspaceStore.subscribe((state, prevState) => {
		const next = state.focusedPaneId;
		const prev = prevState.focusedPaneId;
		if (next === prev) return;
		if (
			shouldSweep(
				prev,
				next,
				hasFocusedBefore,
				useSettingsStore.getState().focusSweep,
			)
		) {
			useFocusSweepStore.setState((s) => ({
				paneId: next,
				nonce: s.nonce + 1,
			}));
		}
		if (next !== null) hasFocusedBefore = true;
	});
}
