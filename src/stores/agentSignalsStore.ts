import { create } from "zustand";

// What Agents show the user about their own pane through Agent control
// (ADR-0056): the **Attention flag**, the **Progress line** and the open
// **Question card**. Per Window, in memory only, keyed by pane id.

export interface AttentionFlag {
	message: string;
	at: number;
}

export interface OpenQuestion {
	/** The id of the Agent control request waiting for the answer. */
	id: string;
	question: string;
	choices: string[];
	/** Offer a text field. */
	text: boolean;
}

export interface QuestionAnswer {
	choice: string | null;
	text: string | null;
}

interface AgentSignalsState {
	flags: Record<string, AttentionFlag>;
	progress: Record<string, string>;
	questions: Record<string, OpenQuestion>;
	setFlag: (paneId: string, message: string) => void;
	clearFlag: (paneId: string) => void;
	setProgress: (paneId: string, text: string | null) => void;
	openQuestion: (paneId: string, q: OpenQuestion) => void;
	/** Remove the pane's question if it is still `id`. */
	closeQuestion: (paneId: string, id: string) => void;
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
	questions: {},
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
	openQuestion: (paneId, q) =>
		set((s) => ({ questions: { ...s.questions, [paneId]: q } })),
	closeQuestion: (paneId, id) =>
		set((s) =>
			s.questions[paneId]?.id === id
				? { questions: without(s.questions, paneId) }
				: s,
		),
	clearPane: (paneId) =>
		set((s) => ({
			flags: without(s.flags, paneId),
			progress: without(s.progress, paneId),
			questions: without(s.questions, paneId),
		})),
}));

/** The panes with an open Question card, as a stable key (ids joined by
 *  newlines, sorted) so a selector re-renders only when the set changes. */
export function askingPanesKey(
	s: Pick<AgentSignalsState, "questions">,
): string {
	return Object.keys(s.questions).sort().join("\n");
}

/** The inverse of `askingPanesKey`. */
export function askingPanesOf(key: string): string[] {
	return key ? key.split("\n") : [];
}

/** Panes that want the user without a status saying so: flagged, or with
 *  an open Question card. Each feeds the **Attention count**. */
export function panesWantingAttention(
	s: Pick<AgentSignalsState, "flags" | "questions">,
): Set<string> {
	return new Set([...Object.keys(s.flags), ...Object.keys(s.questions)]);
}
