import { create } from "zustand";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { collectPaneIds, containsPane } from "./paneTree";

/**
 * The **Focus sweep** trigger rule. A sweep plays whenever the Focused pane
 * changes to a *different* Pane, whatever caused it — including the first
 * focus after the Window opens — but only when the Tab holding it has more
 * than one Pane: with a single Pane there is nothing to find. Re-focusing the
 * already-focused Pane changes nothing, so it never sweeps; neither does the
 * Window regaining OS focus, for the same reason.
 */
export function shouldSweep(
	prev: string | null,
	next: string | null,
	paneCountInTab: number,
	enabled: boolean,
): boolean {
	return enabled && paneCountInTab > 1 && next !== null && next !== prev;
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
	return useWorkspaceStore.subscribe((state, prevState) => {
		const next = state.focusedPaneId;
		const prev = prevState.focusedPaneId;
		if (next === prev) return;
		// The Focused pane is always in the active Tab — tab and workspace
		// switches move both in one update.
		const layout = state.getActiveLayout();
		const paneCount =
			layout && next && containsPane(layout, next)
				? collectPaneIds(layout).length
				: 0;
		if (
			shouldSweep(prev, next, paneCount, useSettingsStore.getState().focusSweep)
		) {
			useFocusSweepStore.setState((s) => ({
				paneId: next,
				nonce: s.nonce + 1,
			}));
		} else if (useFocusSweepStore.getState().paneId !== null) {
			// Focus moved without a new sweep — to a single-pane Tab, say, or to
			// nothing. Drop the old one: its pane may now be hidden (a Tab behind
			// `display: none` never fires `animationend`), and a sweep left in
			// the store would replay the moment that pane is shown again.
			useFocusSweepStore.setState({ paneId: null });
		}
	});
}

/** A frame gap under this counts as smooth (60 Hz is ~17 ms; 30 Hz ~33 ms). */
const SMOOTH_FRAME_MS = 34;
/** Consecutive smooth frames required before a sweep starts. */
const SMOOTH_FRAMES_NEEDED = 2;
/** Start anyway after this long, so a sweep is never withheld indefinitely. */
const MAX_WAIT_MS = 1000;

/**
 * Call `start` once the main thread is painting smoothly again — after
 * `SMOOTH_FRAMES_NEEDED` consecutive frames each under `SMOOTH_FRAME_MS` —
 * or after `MAX_WAIT_MS`, whichever comes first. Returns a cancel function.
 * `now` and `raf` are injectable for tests.
 */
export function waitForSmoothFrames(
	start: () => void,
	raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
	cancelRaf: (id: number) => void = cancelAnimationFrame,
	now: () => number = () => performance.now(),
): () => void {
	const begin = now();
	let last = begin;
	let smooth = 0;
	let id = 0;
	const tick = (t: number) => {
		smooth = t - last < SMOOTH_FRAME_MS ? smooth + 1 : 0;
		last = t;
		if (smooth >= SMOOTH_FRAMES_NEEDED || t - begin >= MAX_WAIT_MS) {
			start();
			return;
		}
		id = raf(tick);
	};
	id = raf(tick);
	return () => cancelRaf(id);
}
