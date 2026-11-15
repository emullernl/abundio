/**
 * The **Orchestrator view**'s streams (ADR-0057), pure: one per Agent
 * control call from one pane at another, from the call's start until a
 * little after its end. A call too quick to see (a `pane read` takes
 * milliseconds) still shows for `MIN_VISIBLE_MS`, so a burst of reads draws
 * as a sweep, then fades for `FADE_MS`.
 *
 * Every function returns the same map when nothing changed, so a store
 * holding it only notifies when there is something new to draw.
 */

import type { ControlActivity } from "./controlActivity";

/** The shortest time a stream is on screen: about one lap of its light. */
export const MIN_VISIBLE_MS = 900;
/** How long a finished stream takes to fade. */
export const FADE_MS = 700;

export interface Stream {
	call: ControlActivity;
	/** When the call ended; null while it runs. */
	endedAt: number | null;
	/** Fading out: no longer lit, no light, its target no longer receiving. */
	fading: boolean;
}

export type Streams = ReadonlyMap<number, Stream>;

export const NO_STREAMS: Streams = new Map();

export function streamStarted(s: Streams, call: ControlActivity): Streams {
	if (s.has(call.id)) return s;
	return new Map(s).set(call.id, { call, endedAt: null, fading: false });
}

export function streamEnded(s: Streams, id: number, now: number): Streams {
	const entry = s.get(id);
	if (!entry || entry.endedAt !== null) return s;
	return new Map(s).set(id, { ...entry, endedAt: now });
}

/**
 * Ends every stream whose call is no longer running, though no end was
 * heard for it: a stream never outlives its call by more than its fade.
 */
export function reconcileStreams(
	s: Streams,
	runningIds: ReadonlySet<number>,
	now: number,
): Streams {
	let out: Map<number, Stream> | null = null;
	for (const [id, entry] of s) {
		if (entry.endedAt === null && !runningIds.has(id)) {
			out ??= new Map(s);
			out.set(id, { ...entry, endedAt: now });
		}
	}
	return out ?? s;
}

/** When an ended stream starts to fade. */
function fadeAt(entry: Stream): number | null {
	if (entry.endedAt === null) return null;
	return Math.max(entry.endedAt, entry.call.startedAt + MIN_VISIBLE_MS);
}

/** Moves ended streams on to fading, and fading ones off the map. */
export function advanceStreams(s: Streams, now: number): Streams {
	let out: Map<number, Stream> | null = null;
	for (const [id, entry] of s) {
		const at = fadeAt(entry);
		if (at === null) continue;
		if (now >= at + FADE_MS) {
			out ??= new Map(s);
			out.delete(id);
		} else if (now >= at && !entry.fading) {
			out ??= new Map(s);
			out.set(id, { ...entry, fading: true });
		}
	}
	return out ?? s;
}

/** The next time `advanceStreams` would change something, or null. */
export function nextStreamChange(s: Streams, now: number): number | null {
	let next: number | null = null;
	for (const entry of s.values()) {
		const at = fadeAt(entry);
		if (at === null) continue;
		const t = entry.fading || now >= at ? at + FADE_MS : at;
		if (next === null || t < next) next = t;
	}
	return next;
}

/** Whether a stream that is still lit is aimed at `paneId`. */
export function isReceiving(s: Streams, paneId: string): boolean {
	for (const entry of s.values()) {
		if (!entry.fading && entry.call.targetPaneId === paneId) return true;
	}
	return false;
}
