// `ask` (ADR-0056): a **Question card** on the asking Agent's own pane. The
// call waits for the user's answer; it ends early when Rust cancels it (its
// timeout, or the CLI interrupted), when the pane closes, or when the
// Agent's turn ends (then nobody is waiting for the answer any more).

import {
	type QuestionAnswer,
	useAgentSignalsStore,
} from "../../stores/agentSignalsStore";
import { subscribeStatusChange } from "../../stores/ptyActivityStore";
import { isPaneVisible } from "../notificationRouter";
import { getWindowBlurredMs } from "../windowFocus";
import { ControlError } from "./types";
import { notifyPopupAllowed, sendPanePopup } from "./userSignals";

const answerers = new Map<string, (a: QuestionAnswer) => void>();

/** The user answered the card `id` on `paneId`. */
export function answerQuestion(
	paneId: string,
	id: string,
	answer: QuestionAnswer,
): void {
	const q = useAgentSignalsStore.getState().questions[paneId];
	if (q?.id !== id) return;
	answerers.get(id)?.(answer);
}

export async function askUser(
	paneId: string,
	ptyId: string,
	senderName: string,
	q: { question: string; choices: string[]; text: boolean },
	signal: AbortSignal,
): Promise<QuestionAnswer> {
	const store = useAgentSignalsStore.getState();
	if (store.questions[paneId]) {
		throw new ControlError(
			"busy",
			"you already have a question open; wait for its answer first",
		);
	}
	const id = crypto.randomUUID();
	const text = q.text || q.choices.length === 0;
	store.openQuestion(paneId, {
		id,
		question: q.question,
		choices: q.choices,
		text,
	});
	// As for Waiting: tell the user when they are elsewhere.
	if (
		notifyPopupAllowed({
			lastPopupAt: undefined,
			now: Date.now(),
			blurredMs: getWindowBlurredMs(),
			paneVisible: isPaneVisible(paneId),
		})
	) {
		sendPanePopup(paneId, `${senderName} asks: ${q.question}`);
	}

	let cleanup = () => {};
	try {
		return await new Promise<QuestionAnswer>((resolve, reject) => {
			answerers.set(id, resolve);
			const onAbort = () =>
				reject(new ControlError("cancelled", "the question was withdrawn"));
			if (signal.aborted) onAbort();
			signal.addEventListener("abort", onAbort);
			// The pane closed: its card went with it.
			const unsubStore = useAgentSignalsStore.subscribe((s) => {
				if (s.questions[paneId]?.id !== id && answerers.has(id)) {
					reject(new ControlError("exited", "the pane closed"));
				}
			});
			// The Agent's turn ended or it left: nobody waits for the answer.
			const unsubStatus = subscribeStatusChange(({ ptyId: p, next }) => {
				if (p !== ptyId) return;
				if (next.state === "ready" || next.detectionMode !== "agent") {
					reject(new ControlError("exited", "your turn ended"));
				}
			});
			cleanup = () => {
				signal.removeEventListener("abort", onAbort);
				unsubStore();
				unsubStatus();
			};
		});
	} finally {
		cleanup();
		answerers.delete(id);
		useAgentSignalsStore.getState().closeQuestion(paneId, id);
	}
}

/** Whether `paneId` has an open Question card: it then shows as Waiting. */
export function hasOpenQuestion(paneId: string): boolean {
	return !!useAgentSignalsStore.getState().questions[paneId];
}
