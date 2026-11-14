import { create } from "zustand";

// What Agents show the user about their own pane through Agent control
// (ADR-0056): the **Attention flag** and the **Progress line**. Per Window,
// in memory only, keyed by pane id.

export interface AttentionFlag {
	message: string;
	at: number;
}

interface AgentSignalsState {
	flags: Record<string, AttentionFlag>;
	progress: Record<string, string>;
	setFlag: (paneId: string, message: string) => void;
	clearFlag: (paneId: string) => void;
	setProgress: (paneId: string, text: string | null) => void;
	/** Forget everything about a pane (it closed, or its Agent left). */
	clearPane: (paneId: string) => void;
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
	if (!(key in map)) return map;
	const { [key]: _gone, ...rest } = map;
	return rest;
}

export const useAgentSignalsStore = create<AgentSignalsState>()((set) => ({
	flags: {},
	progress: {},
	setFlag: (paneId, message) =>
		set((s) => ({
			flags: { ...s.flags, [paneId]: { message, at: Date.now() } },
		})),
	clearFlag: (paneId) => set((s) => ({ flags: without(s.flags, paneId) })),
	setProgress: (paneId, text) =>
		set((s) => ({
			progress:
				text === null
					? without(s.progress, paneId)
					: { ...s.progress, [paneId]: text },
		})),
	clearPane: (paneId) =>
		set((s) => ({
			flags: without(s.flags, paneId),
			progress: without(s.progress, paneId),
		})),
}));

/** Panes that want the user without a status saying so: those with an
 *  Attention flag. Each feeds the **Attention count**. */
export function panesWantingAttention(
	s: Pick<AgentSignalsState, "flags">,
): Set<string> {
	return new Set(Object.keys(s.flags));
}
