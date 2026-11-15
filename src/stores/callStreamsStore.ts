import { create } from "zustand";
import {
	advanceStreams,
	isReceiving,
	NO_STREAMS,
	nextStreamChange,
	reconcileStreams,
	type Streams,
	streamEnded,
	streamStarted,
} from "../lib/callStreams";
import {
	runningControlActivity,
	subscribeControlActivity,
} from "../lib/controlActivity";

/** How long a node glows for a call that touched no other pane. */
export const PULSE_MS = 1600;

interface CallStreamsState {
	/** The Orchestrator graph's streams (lib/callStreams.ts). */
	streams: Streams;
	/** Panes glowing for a call that touched no other pane (`file open`). */
	pulsing: ReadonlySet<string>;
}

/**
 * What the **Orchestrator view**'s graph animates, kept outside the graph
 * so a call re-renders only the nodes it touches, never the whole chart
 * (React Flow re-measures a node it is handed anew, and hides it until
 * then). Listens from the moment this module loads, so no call's end is
 * missed while the graph is mounting.
 */
export const useCallStreamsStore = create<CallStreamsState>(() => ({
	streams: NO_STREAMS,
	pulsing: new Set(),
}));

/** Whether a lit stream is aimed at `paneId`, or it is pulsing. */
export function selectReceiving(paneId: string | null) {
	return (s: CallStreamsState) =>
		paneId !== null &&
		(s.pulsing.has(paneId) || isReceiving(s.streams, paneId));
}

let timer: ReturnType<typeof setTimeout> | null = null;
const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function update(change: (s: Streams, now: number) => Streams): void {
	const now = Date.now();
	const before = useCallStreamsStore.getState().streams;
	const running = new Set(runningControlActivity().map((c) => c.id));
	const after = advanceStreams(
		reconcileStreams(change(before, now), running, now),
		now,
	);
	if (after !== before) useCallStreamsStore.setState({ streams: after });
	schedule(after, now);
}

function schedule(s: Streams, now: number): void {
	if (timer !== null) clearTimeout(timer);
	timer = null;
	const next = nextStreamChange(s, now);
	if (next === null) return;
	timer = setTimeout(
		() => {
			timer = null;
			update((x) => x);
		},
		Math.max(0, next - now),
	);
}

let installed = false;

/** Starts listening. Called when this module loads; safe to call again. */
export function installCallStreams(): void {
	if (installed) return;
	installed = true;
	subscribeControlActivity((e) => {
		if (e.type === "start") {
			update((s) => streamStarted(s, e.call));
		} else if (e.type === "end") {
			update((s, now) => streamEnded(s, e.id, now));
		} else {
			const paneId = e.paneId;
			useCallStreamsStore.setState((s) => ({
				pulsing: new Set(s.pulsing).add(paneId),
			}));
			// A pulse during a pulse starts its glow over, never cut short.
			clearTimeout(pulseTimers.get(paneId));
			pulseTimers.set(
				paneId,
				setTimeout(() => {
					pulseTimers.delete(paneId);
					useCallStreamsStore.setState((s) => {
						const next = new Set(s.pulsing);
						next.delete(paneId);
						return { pulsing: next };
					});
				}, PULSE_MS),
			);
		}
	});
	// Calls already running when this module loaded.
	update((s) =>
		runningControlActivity().reduce((acc, c) => streamStarted(acc, c), s),
	);
}

installCallStreams();
