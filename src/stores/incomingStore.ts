import { create } from "zustand";
import type { PullOutcome, UpstreamState } from "../lib/types";

/** What the Pull dialog shows: the busy-Agent confirmation, or why a Pull did
 *  not happen. */
export type PullDialog =
	| { kind: "confirmBusy"; workspaceId: string }
	| { kind: "outcome"; workspaceId: string; outcome: PullOutcome };

/**
 * **Incoming commits** per Workspace (ADR-0066), in memory, this Window only.
 * Its own store, not a field of `WorkspaceGitInfo`, because several writers
 * replace that wholesale.
 */
interface IncomingState {
	/** From each scheduler bundle. Missing: no bundle yet. Null: no Upstream. */
	upstreamById: Record<string, UpstreamState | null>;
	/** When this Window last tried to fetch each Workspace, epoch ms. */
	lastAttemptById: Record<string, number>;
	/** The last fetch's failure, cleared by a success. */
	errorById: Record<string, string>;
	checking: Set<string>;
	pulling: Set<string>;
	dialog: PullDialog | null;

	setUpstream: (workspaceId: string, u: UpstreamState | null) => void;
	forget: (workspaceId: string) => void;
	startCheck: (workspaceId: string) => void;
	endCheck: (workspaceId: string, error: string | null) => void;
	setPulling: (workspaceId: string, on: boolean) => void;
	setDialog: (d: PullDialog | null) => void;
}

function without<T>(r: Record<string, T>, key: string): Record<string, T> {
	if (!(key in r)) return r;
	const { [key]: _, ...rest } = r;
	return rest;
}

function toggled(s: Set<string>, id: string, on: boolean): Set<string> {
	if (s.has(id) === on) return s;
	const next = new Set(s);
	if (on) next.add(id);
	else next.delete(id);
	return next;
}

function upstreamEqual(a: UpstreamState | null, b: UpstreamState | null) {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.name === b.name &&
		a.incoming === b.incoming &&
		a.outgoing === b.outgoing &&
		a.lastFetched === b.lastFetched &&
		a.incomingCommits.length === b.incomingCommits.length &&
		a.incomingCommits.every((c, i) => c.oid === b.incomingCommits[i].oid)
	);
}

export const useIncomingStore = create<IncomingState>((set) => ({
	upstreamById: {},
	lastAttemptById: {},
	errorById: {},
	checking: new Set(),
	pulling: new Set(),
	dialog: null,

	setUpstream: (workspaceId, u) =>
		set((s) => {
			const prev = s.upstreamById[workspaceId];
			if (prev !== undefined && upstreamEqual(prev, u)) return s;
			return { upstreamById: { ...s.upstreamById, [workspaceId]: u } };
		}),
	forget: (workspaceId) =>
		set((s) => ({
			upstreamById: without(s.upstreamById, workspaceId),
			lastAttemptById: without(s.lastAttemptById, workspaceId),
			errorById: without(s.errorById, workspaceId),
		})),
	startCheck: (workspaceId) =>
		set((s) => ({
			checking: toggled(s.checking, workspaceId, true),
			lastAttemptById: { ...s.lastAttemptById, [workspaceId]: Date.now() },
		})),
	endCheck: (workspaceId, error) =>
		set((s) => ({
			checking: toggled(s.checking, workspaceId, false),
			errorById: error
				? { ...s.errorById, [workspaceId]: error }
				: without(s.errorById, workspaceId),
		})),
	setPulling: (workspaceId, on) =>
		set((s) => ({ pulling: toggled(s.pulling, workspaceId, on) })),
	setDialog: (dialog) => set({ dialog }),
}));
