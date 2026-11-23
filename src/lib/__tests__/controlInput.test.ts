import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
	onAction: vi.fn(),
}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { noteControlInput } from "../terminalManager";

// Rust types an `agent prompt` into the PTY itself (control_local.rs) and
// tells the Window, which must keep the bookkeeping a typed keystroke does,
// as when it pasted the prompt through xterm.js.
function agentIn(state: "waiting" | "ready"): void {
	const s = usePtyActivityStore.getState();
	usePtyActivityStore.setState({ panePtyMap: { p: "pty" } });
	s.initPty("pty", "agent");
	s.applyHookEvent("pty", state, true);
}

const stateOf = () => usePtyActivityStore.getState().activities.pty?.state;

describe("input Rust typed for Agent control", () => {
	it("answers a Waiting Agent on Enter, as a keystroke would", () => {
		agentIn("waiting");
		noteControlInput("p", "\x1b[200~yes\x1b[201~");
		expect(stateOf()).toBe("waiting");
		noteControlInput("p", "\r");
		expect(stateOf()).toBe("active");
	});

	it("takes a Ready Agent back to Idle until it starts working", () => {
		agentIn("ready");
		noteControlInput("p", "fix it");
		expect(stateOf()).toBe("idle");
	});

	it("does nothing for a pane with no PTY", () => {
		expect(() => noteControlInput("nowhere", "\r")).not.toThrow();
	});
});
