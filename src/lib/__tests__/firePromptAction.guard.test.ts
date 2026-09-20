/**
 * The **Waiting** guard, driven through the real status machine.
 *
 * `promptActions.test.ts` proves `canFire` returns the right answer, and
 * `ActionBar.test.tsx` proves the bar disables when told to. Neither proves the
 * thing that actually matters: that a *send* is refused when the live store
 * says Waiting.
 *
 * So this drives `ptyActivityStore.applyHookEvent(ptyId, "waiting")` — the same
 * transition a real permission-request hook causes, through the same reducer —
 * and then calls `firePromptAction` and checks nothing reached the terminal.
 *
 * What it still does not cover, and cannot from here: that a real Agent's
 * permission hook arrives and produces that transition. That is the hook
 * pipeline (ADR-0015), it predates this feature, and it is the same signal the
 * status icon has always been driven by — but it is the one link that needs the
 * running app. See docs/plans/prompt-actions.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const paste = vi.fn();
const input = vi.fn();
const focus = vi.fn();

vi.mock("../terminalManager", () => ({
	getTerminal: (paneId: string) =>
		paneId === "pane-1"
			? { ptyId: "pty-1", term: { paste, input, focus } }
			: undefined,
}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { firePromptAction } from "../firePromptAction";

const PANE = "pane-1";
const PTY = "pty-1";

function fire() {
	return firePromptAction(
		PANE,
		"Review this",
		{},
		{},
		{ actionId: "action-a" },
	);
}

describe("firePromptAction — the Waiting guard", () => {
	beforeEach(() => {
		paste.mockClear();
		input.mockClear();
		focus.mockClear();
		usePtyActivityStore.setState({
			activities: {},
			panePtyMap: {},
			agentPtyIds: new Set(),
			detectedAgentIds: {},
		});
		useWorkspaceStore.setState({ focusedPaneId: null });
		usePtyActivityStore.getState().initPty(PTY);
		usePtyActivityStore.getState().setAgentPty(PTY, "claude");
	});

	it("sends while the agent is idle", () => {
		expect(fire()).toEqual({ ok: true });
		expect(paste).toHaveBeenCalledWith("Review this");
		expect(input).toHaveBeenCalledWith("\r");
	});

	it("refuses once a permission hook puts the agent into Waiting", () => {
		// The real transition, through the real reducer — not a hand-set field.
		usePtyActivityStore.getState().applyHookEvent(PTY, "waiting");
		expect(usePtyActivityStore.getState().activities[PTY]?.state).toBe(
			"waiting",
		);

		expect(fire()).toEqual({ ok: false, reason: "waiting" });
	});

	it("writes absolutely nothing to the PTY while Waiting", () => {
		// The point of the guard. A permission prompt has redefined what
		// keystrokes mean, so even the paste alone could answer it.
		usePtyActivityStore.getState().applyHookEvent(PTY, "waiting");
		fire();
		expect(paste).not.toHaveBeenCalled();
		expect(input).not.toHaveBeenCalled();
	});

	it("does not steal focus while Waiting", () => {
		// Focusing the pane would be a visible side effect of a refused action.
		usePtyActivityStore.getState().applyHookEvent(PTY, "waiting");
		fire();
		expect(useWorkspaceStore.getState().focusedPaneId).toBeNull();
	});

	it("sends again once the Waiting state clears", () => {
		usePtyActivityStore.getState().applyHookEvent(PTY, "waiting");
		expect(fire().ok).toBe(false);

		usePtyActivityStore.getState().clearWaiting(PTY);
		expect(fire()).toEqual({ ok: true });
		expect(paste).toHaveBeenCalledWith("Review this");
	});

	it("still sends while the agent is Working", () => {
		// Queuing a follow-up mid-turn is deliberate, not an oversight.
		usePtyActivityStore.getState().applyHookEvent(PTY, "active");
		expect(usePtyActivityStore.getState().activities[PTY]?.state).toBe(
			"active",
		);
		expect(fire()).toEqual({ ok: true });
	});
});
