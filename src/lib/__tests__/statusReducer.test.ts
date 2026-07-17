import { describe, expect, it } from "vitest";
import {
	DEFAULT_STATUS_CONFIG,
	HOOK_IDLE_BACKSTOP_MS,
	IDLE_THRESHOLD_MS,
	INPUT_GATE_MS,
	initialStatusState,
	type StatusEvent,
	type StatusMode,
	type StatusState,
	SUBAGENT_STALE_MS,
	statusReducer,
} from "../statusReducer";

/** Build a state, defaulting to a fresh shell PTY. */
function mk(
	overrides: Partial<StatusState> = {},
	mode: StatusMode = "shell",
): StatusState {
	return { ...initialStatusState(mode), ...overrides };
}

/** Fold a sequence of events. */
function run(state: StatusState, ...events: StatusEvent[]): StatusState {
	return events.reduce((s, e) => statusReducer(s, e), state);
}

describe("statusReducer — initial state", () => {
	it("starts Idle, shell mode, not hook-driven", () => {
		const s = initialStatusState("shell");
		expect(s.state).toBe("idle");
		expect(s.mode).toBe("shell");
		expect(s.hookDriven).toBe(false);
		expect(s.shellCommandRunning).toBe(false);
	});
});

describe("statusReducer — hook transitions (applyHookEvent parity)", () => {
	it("Working sets hookDriven + activity markers", () => {
		const s = statusReducer(mk({}, "agent"), {
			kind: "hook",
			transition: "working",
			now: 100,
		});
		expect(s.state).toBe("working");
		expect(s.hookDriven).toBe(true);
		expect(s.workingSince).toBe(100);
		expect(s.lastActivityAt).toBe(100);
	});

	it("Waiting / Ready / Error set hookDriven without touching activity markers", () => {
		for (const transition of ["waiting", "ready", "error"] as const) {
			const s = statusReducer(
				mk({ workingSince: 5, lastActivityAt: 5 }, "agent"),
				{
					kind: "hook",
					transition,
					now: 100,
				},
			);
			expect(s.state).toBe(transition);
			expect(s.hookDriven).toBe(true);
			expect(s.lastActivityAt).toBe(5);
		}
	});

	it("Idle (Kimi's Interrupt) cancels a Working agent and drops its Subagents", () => {
		// The authoritative user-cancel: straight to Idle — never a Ready flash
		// (the user just acted, nothing is unacknowledged) — and delegated work
		// is dropped exactly like the ESC cancel path (ADR-0022).
		const s = statusReducer(
			mk(
				{
					state: "working",
					hookDriven: true,
					activeSubagents: [{ id: "sub-1", startedAt: 50 }],
					stopHeldForSubagents: true,
					lastEscAt: 90,
				},
				"agent",
			),
			{ kind: "hook", transition: "idle", now: 100 },
		);
		expect(s.state).toBe("idle");
		expect(s.hookDriven).toBe(true);
		expect(s.activeSubagents).toEqual([]);
		expect(s.stopHeldForSubagents).toBe(false);
		expect(s.lastEscAt).toBeNull();
	});
});

describe("statusReducer — agent/session mode flips", () => {
	it("agentDetected flips shell → agent and clears shellCommandRunning", () => {
		const s = statusReducer(mk({ shellCommandRunning: true }), {
			kind: "agentDetected",
		});
		expect(s.mode).toBe("agent");
		expect(s.shellCommandRunning).toBe(false);
	});

	it("agentDetected is idempotent when already agent", () => {
		const before = mk({ state: "working" }, "agent");
		expect(statusReducer(before, { kind: "agentDetected" })).toBe(before);
	});

	it("sessionEnded flips agent → shell and drops hookDriven (state untouched)", () => {
		const s = statusReducer(mk({ state: "ready", hookDriven: true }, "agent"), {
			kind: "sessionEnded",
		});
		expect(s.mode).toBe("shell");
		expect(s.hookDriven).toBe(false);
		expect(s.state).toBe("ready");
	});

	it("sessionEnded is idempotent when already shell", () => {
		const before = mk({}, "shell");
		expect(statusReducer(before, { kind: "sessionEnded" })).toBe(before);
	});
});

describe("statusReducer — shell command lifecycle", () => {
	it("command start → Working + running flag", () => {
		const s = statusReducer(mk(), { kind: "shellCommandStarted", now: 10 });
		expect(s.state).toBe("working");
		expect(s.shellCommandRunning).toBe(true);
		expect(s.workingSince).toBe(10);
	});

	it("clean command end → Idle (no Ready hop for shells)", () => {
		const s = run(
			mk(),
			{ kind: "shellCommandStarted", now: 10 },
			{ kind: "shellCommandEnded", exit: 0 },
		);
		expect(s.state).toBe("idle");
		expect(s.shellCommandRunning).toBe(false);
	});

	it("failed command end → Error", () => {
		const s = run(
			mk(),
			{ kind: "shellCommandStarted", now: 10 },
			{ kind: "shellCommandEnded", exit: 1 },
		);
		expect(s.state).toBe("error");
	});

	it("user-stop codes 130/143 are clean exits", () => {
		for (const exit of [130, 143]) {
			const s = run(
				mk(),
				{ kind: "shellCommandStarted", now: 10 },
				{ kind: "shellCommandEnded", exit },
			);
			expect(s.state).toBe("idle");
		}
	});

	it("process-monitor end (exit undefined) → Idle", () => {
		const s = run(
			mk(),
			{ kind: "shellCommandStarted", now: 10 },
			{ kind: "shellCommandEnded", exit: undefined },
		);
		expect(s.state).toBe("idle");
	});

	it("shell command events are ignored in agent mode", () => {
		const before = mk({ state: "working" }, "agent");
		expect(statusReducer(before, { kind: "shellCommandStarted", now: 1 })).toBe(
			before,
		);
		expect(statusReducer(before, { kind: "shellCommandEnded", exit: 1 })).toBe(
			before,
		);
	});
});

describe("statusReducer — PTY exit classification (ADR-0009 asymmetry)", () => {
	it("agent clean exit → Ready, shell clean exit → Idle", () => {
		expect(
			statusReducer(mk({ state: "working" }, "agent"), {
				kind: "ptyExited",
				code: 0,
			}).state,
		).toBe("ready");
		expect(
			statusReducer(mk({ state: "working" }, "shell"), {
				kind: "ptyExited",
				code: 0,
			}).state,
		).toBe("idle");
	});

	it("non-zero exit → Error for both modes", () => {
		expect(
			statusReducer(mk({}, "agent"), { kind: "ptyExited", code: 1 }).state,
		).toBe("error");
		expect(
			statusReducer(mk({}, "shell"), { kind: "ptyExited", code: 1 }).state,
		).toBe("error");
	});

	it("user-stop exit is clean", () => {
		expect(
			statusReducer(mk({}, "agent"), { kind: "ptyExited", code: 130 }).state,
		).toBe("ready");
	});
});

describe("statusReducer — Waiting guard (ADR-0015)", () => {
	it("a Waiting agent's own output never clears the dot (only refreshes activity)", () => {
		// hookDriven Waiting agent — output keeps it Waiting, bumps lastActivityAt.
		const s = statusReducer(
			mk({ state: "waiting", hookDriven: true }, "agent"),
			{
				kind: "output",
				bytes: 100000,
				now: 9000,
			},
		);
		expect(s.state).toBe("waiting");
		expect(s.lastActivityAt).toBe(9000);
	});

	it("recordActivity refuses to leave Waiting even on a threshold fire", () => {
		// Synthetic non-hook Waiting agent: drive enough output to fire — still Waiting.
		let s = mk(
			{ state: "waiting", hookDriven: false, lastInputAt: 0 },
			"agent",
		);
		for (let i = 0; i < 6; i++)
			s = statusReducer(s, { kind: "output", bytes: 2048, now: 10000 + i });
		expect(s.state).toBe("waiting");
	});
});

describe("statusReducer — output heuristic (non-hook-driven agents)", () => {
	it("fires Working only after the required threshold hits", () => {
		let s = mk({ lastInputAt: 0 }, "agent");
		for (let i = 0; i < 4; i++)
			s = statusReducer(s, { kind: "output", bytes: 1024, now: 10000 + i });
		expect(s.state).toBe("idle"); // 4 hits — not yet
		s = statusReducer(s, { kind: "output", bytes: 1024, now: 10004 });
		expect(s.state).toBe("working"); // 5th hit fires
	});

	it("respects the input gate after a keystroke", () => {
		const within = statusReducer(mk({ lastInputAt: 10000 }, "agent"), {
			kind: "output",
			bytes: 100000,
			now: 10000 + INPUT_GATE_MS,
		});
		expect(within.bytesSinceIdle).toBe(0); // gated — not accumulated
		expect(within.state).toBe("idle");
	});

	it("hook-driven agents ignore the heuristic, only refreshing activity", () => {
		const s = statusReducer(
			mk({ state: "ready", hookDriven: true, lastInputAt: 0 }, "agent"),
			{
				kind: "output",
				bytes: 100000,
				now: 50000,
			},
		);
		expect(s.state).toBe("ready"); // unchanged
		expect(s.lastActivityAt).toBe(50000);
	});

	it("an already-Working agent stays Working and refreshes activity", () => {
		const s = statusReducer(mk({ state: "working", lastInputAt: 0 }, "agent"), {
			kind: "output",
			bytes: 100000,
			now: 60000,
		});
		expect(s.state).toBe("working");
		expect(s.lastActivityAt).toBe(60000);
	});

	it("output is ignored in shell mode", () => {
		const before = mk({}, "shell");
		expect(
			statusReducer(before, { kind: "output", bytes: 100000, now: 99999 }),
		).toBe(before);
	});
});

describe("statusReducer — keystrokes answering a Waiting agent", () => {
	it("Enter/digit answers → Working (hook-driven)", () => {
		const s = statusReducer(mk({ state: "waiting" }, "agent"), {
			kind: "keystroke",
			key: "answer",
			escRequired: 1,
			now: 5000,
		});
		expect(s.state).toBe("working");
		expect(s.hookDriven).toBe(true);
		expect(s.workingSince).toBe(5000);
	});

	it("bare ESC dismisses → Idle", () => {
		const s = statusReducer(mk({ state: "waiting" }, "agent"), {
			kind: "keystroke",
			key: "esc",
			escRequired: 1,
			now: 5000,
		});
		expect(s.state).toBe("idle");
	});

	it("any other key leaves it Waiting", () => {
		const s = statusReducer(mk({ state: "waiting" }, "agent"), {
			kind: "keystroke",
			key: "other",
			escRequired: 1,
			now: 5000,
		});
		expect(s.state).toBe("waiting");
	});
});

describe("statusReducer — ESC cancel of a Working agent", () => {
	it("single-press agents (escRequired 1) cancel immediately", () => {
		const s = statusReducer(mk({ state: "working" }, "agent"), {
			kind: "keystroke",
			key: "esc",
			escRequired: 1,
			now: 1000,
		});
		expect(s.state).toBe("idle");
	});

	it("double-press agents: first ESC arms, second within window cancels", () => {
		const armed = statusReducer(mk({ state: "working" }, "agent"), {
			kind: "keystroke",
			key: "esc",
			escRequired: 2,
			now: 1000,
		});
		expect(armed.state).toBe("working");
		expect(armed.lastEscAt).toBe(1000);
		const cancelled = statusReducer(armed, {
			kind: "keystroke",
			key: "esc",
			escRequired: 2,
			now: 1500,
		});
		expect(cancelled.state).toBe("idle");
	});

	it("double-press: second ESC after the window re-arms instead of cancelling", () => {
		const armed = statusReducer(
			mk({ state: "working", lastEscAt: 1000 }, "agent"),
			{
				kind: "keystroke",
				key: "esc",
				escRequired: 2,
				now: 2000,
			},
		);
		expect(armed.state).toBe("working");
		expect(armed.lastEscAt).toBe(2000);
	});

	it("any non-ESC key resets the double-press tracker", () => {
		const s = statusReducer(
			mk({ state: "working", lastEscAt: 1000 }, "agent"),
			{
				kind: "keystroke",
				key: "other",
				escRequired: 2,
				now: 1200,
			},
		);
		expect(s.state).toBe("working");
		expect(s.lastEscAt).toBeNull();
	});
});

describe("statusReducer — keystroke acknowledgement (else branch)", () => {
	it("clears Error and dismisses Ready", () => {
		expect(
			statusReducer(mk({ state: "error" }, "agent"), {
				kind: "keystroke",
				key: "other",
				escRequired: 1,
				now: 1,
			}).state,
		).toBe("idle");
		expect(
			statusReducer(mk({ state: "ready" }, "agent"), {
				kind: "keystroke",
				key: "other",
				escRequired: 1,
				now: 1,
			}).state,
		).toBe("idle");
	});

	it("resets the input-gate clock and byte accumulator", () => {
		const s = statusReducer(mk({ bytesSinceIdle: 999, lastInputAt: 0 }), {
			kind: "keystroke",
			key: "other",
			escRequired: 2,
			now: 7777,
		});
		expect(s.lastInputAt).toBe(7777);
		expect(s.bytesSinceIdle).toBe(0);
	});
});

describe("statusReducer — idle scan (Tick)", () => {
	it("non-hook-driven Working agent goes Ready past the 2s threshold", () => {
		const stale = mk(
			{ state: "working", hookDriven: false, lastActivityAt: 0 },
			"agent",
		);
		expect(
			statusReducer(stale, { kind: "tick", now: IDLE_THRESHOLD_MS + 1 }).state,
		).toBe("ready");
		expect(
			statusReducer(stale, { kind: "tick", now: IDLE_THRESHOLD_MS }).state,
		).toBe("working"); // not strictly past
	});

	it("hook-driven agents only time out at the 30s backstop", () => {
		const stale = mk(
			{ state: "working", hookDriven: true, lastActivityAt: 0 },
			"agent",
		);
		expect(
			statusReducer(stale, { kind: "tick", now: IDLE_THRESHOLD_MS + 1 }).state,
		).toBe("working");
		expect(
			statusReducer(stale, { kind: "tick", now: HOOK_IDLE_BACKSTOP_MS + 1 })
				.state,
		).toBe("ready");
	});

	it("a stale Working shell goes Idle, not Ready (ADR-0009)", () => {
		const stale = mk({ state: "working", lastActivityAt: 0 }, "shell");
		expect(
			statusReducer(stale, { kind: "tick", now: IDLE_THRESHOLD_MS + 1 }).state,
		).toBe("idle");
	});

	it("a running shell command blocks the scan", () => {
		const running = mk(
			{ state: "working", shellCommandRunning: true, lastActivityAt: 0 },
			"shell",
		);
		expect(statusReducer(running, { kind: "tick", now: 999999 }).state).toBe(
			"working",
		);
	});

	it("falls back to workingSince when lastActivityAt is null", () => {
		const s = mk(
			{ state: "working", lastActivityAt: null, workingSince: 0 },
			"agent",
		);
		expect(
			statusReducer(s, { kind: "tick", now: IDLE_THRESHOLD_MS + 1 }).state,
		).toBe("ready");
	});

	it("never touches non-Working states", () => {
		for (const state of ["idle", "waiting", "ready", "error"] as const) {
			const before = mk({ state, lastActivityAt: 0 }, "agent");
			expect(statusReducer(before, { kind: "tick", now: 999999 })).toBe(before);
		}
	});
});

describe("statusReducer — focus reassertion", () => {
	it("dismisses Ready but never cancels in-flight work or clears Error", () => {
		expect(
			statusReducer(mk({ state: "ready" }, "agent"), { kind: "focus" }).state,
		).toBe("idle");
		expect(
			statusReducer(mk({ state: "error" }, "agent"), { kind: "focus" }).state,
		).toBe("error");
		expect(
			statusReducer(mk({ state: "working" }, "agent"), { kind: "focus" }).state,
		).toBe("working");
		expect(
			statusReducer(mk({ state: "waiting" }, "agent"), { kind: "focus" }).state,
		).toBe("waiting");
	});

	it("idles a finished shell but not a running one", () => {
		expect(
			statusReducer(mk({ state: "working" }, "shell"), { kind: "focus" }).state,
		).toBe("idle");
		expect(
			statusReducer(
				mk({ state: "working", shellCommandRunning: true }, "shell"),
				{ kind: "focus" },
			).state,
		).toBe("working");
	});
});

describe("statusReducer — click", () => {
	it("dismisses a Waiting agent (clearWaiting on pane click)", () => {
		expect(
			statusReducer(mk({ state: "waiting" }, "agent"), { kind: "click" }).state,
		).toBe("idle");
	});

	it("clears Error and dismisses Ready", () => {
		expect(
			statusReducer(mk({ state: "error" }, "agent"), { kind: "click" }).state,
		).toBe("idle");
		expect(
			statusReducer(mk({ state: "ready" }, "agent"), { kind: "click" }).state,
		).toBe("idle");
	});

	it("never cancels an in-flight Working agent", () => {
		expect(
			statusReducer(mk({ state: "working" }, "agent"), { kind: "click" }).state,
		).toBe("working");
	});
});

describe("statusReducer — purity", () => {
	it("never mutates the input state", () => {
		const before = mk({ state: "working", lastActivityAt: 5 }, "agent");
		const snapshot = JSON.stringify(before);
		statusReducer(before, { kind: "tick", now: 999999 }, DEFAULT_STATUS_CONFIG);
		statusReducer(before, { kind: "hook", transition: "ready", now: 1 });
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});

describe("statusReducer — Subagent hold (ADR-0022)", () => {
	const start = (id: string, now: number): StatusEvent => ({
		kind: "subagentStarted",
		agentId: id,
		now,
	});
	const stop = (id: string, now = 0): StatusEvent => ({
		kind: "subagentStopped",
		agentId: id,
		now,
	});
	const mainStop = (now: number): StatusEvent => ({
		kind: "hook",
		transition: "ready",
		now,
	});

	it("Stop with an empty set still goes Ready (regression guard)", () => {
		const s = run(mk({ state: "working" }, "agent"), mainStop(100));
		expect(s.state).toBe("ready");
		expect(s.stopHeldForSubagents).toBe(false);
	});

	it("Stop with live Subagents holds Working; stops drain; last stop releases Ready", () => {
		let s = run(
			mk({ state: "working" }, "agent"),
			start("a", 10),
			start("b", 20),
			mainStop(100),
		);
		expect(s.state).toBe("working");
		expect(s.stopHeldForSubagents).toBe(true);

		s = statusReducer(s, stop("a"));
		expect(s.state).toBe("working");
		expect(s.activeSubagents).toHaveLength(1);

		s = statusReducer(s, stop("b"));
		expect(s.state).toBe("ready");
		expect(s.stopHeldForSubagents).toBe(false);
		expect(s.activeSubagents).toHaveLength(0);
	});

	it("a stop with an unknown id is a no-op (mid-session provisioning)", () => {
		const before = mk({ state: "ready" }, "agent");
		expect(statusReducer(before, stop("ghost"))).toBe(before);
	});

	it("a duplicate start refreshes startedAt without growing the set", () => {
		const s = run(
			mk({ state: "working" }, "agent"),
			start("a", 10),
			start("a", 500),
		);
		expect(s.activeSubagents).toHaveLength(1);
		expect(s.activeSubagents[0].startedAt).toBe(500);
	});

	it("a start from idle/ready forces Working + hookDriven", () => {
		for (const state of ["idle", "ready"] as const) {
			const s = statusReducer(mk({ state }, "agent"), start("a", 10));
			expect(s.state).toBe("working");
			expect(s.hookDriven).toBe(true);
		}
	});

	it("a start never overrides Waiting or Error (blocked/failed outrank delegation)", () => {
		for (const state of ["waiting", "error"] as const) {
			const s = statusReducer(mk({ state }, "agent"), start("a", 10));
			expect(s.state).toBe(state);
			expect(s.activeSubagents).toHaveLength(1);
		}
	});

	it("the tick backstop is suppressed while Subagents are alive", () => {
		const held = run(
			mk({ state: "working", hookDriven: true, lastActivityAt: 0 }, "agent"),
			start("a", 0),
			mainStop(1),
		);
		// Way past HOOK_IDLE_BACKSTOP_MS but before SUBAGENT_STALE_MS: still held.
		const s = statusReducer(held, {
			kind: "tick",
			now: HOOK_IDLE_BACKSTOP_MS * 10,
		});
		expect(s.state).toBe("working");
	});

	it("the tick prunes stale Subagents and releases a held Stop", () => {
		const held = run(
			mk({ state: "working", hookDriven: true, lastActivityAt: 0 }, "agent"),
			start("a", 0),
			mainStop(1),
		);
		const s = statusReducer(held, { kind: "tick", now: SUBAGENT_STALE_MS + 1 });
		expect(s.state).toBe("ready");
		expect(s.activeSubagents).toHaveLength(0);
		expect(s.stopHeldForSubagents).toBe(false);
	});

	it("pruning without a held Stop keeps Working (main still mid-turn)", () => {
		const s = statusReducer(
			run(
				mk({ state: "working", hookDriven: true, lastActivityAt: 0 }, "agent"),
				start("a", 0),
			),
			{ kind: "tick", now: SUBAGENT_STALE_MS + 1 },
		);
		expect(s.state).toBe("working");
		expect(s.activeSubagents).toHaveLength(0);
	});

	it("StopFailure while Subagents run goes Error and stays Error when drained", () => {
		let s = run(mk({ state: "working" }, "agent"), start("a", 0), {
			kind: "hook",
			transition: "error",
			now: 1,
		});
		expect(s.state).toBe("error");
		expect(s.stopHeldForSubagents).toBe(false);
		s = statusReducer(s, stop("a"));
		expect(s.state).toBe("error");
		expect(s.activeSubagents).toHaveLength(0);
	});

	it("a new prompt clears the hold but keeps the set; the next Stop re-holds", () => {
		let s = run(mk({ state: "working" }, "agent"), start("a", 0), mainStop(1), {
			kind: "hook",
			transition: "working",
			now: 2,
		});
		expect(s.state).toBe("working");
		expect(s.stopHeldForSubagents).toBe(false);
		expect(s.activeSubagents).toHaveLength(1);
		s = statusReducer(s, mainStop(3));
		expect(s.state).toBe("working");
		expect(s.stopHeldForSubagents).toBe(true);
	});

	it("sessionEnded / ptyExited / ESC-cancel clear set and hold", () => {
		const held = () =>
			run(mk({ state: "working" }, "agent"), start("a", 0), mainStop(1));

		const ended = statusReducer(held(), { kind: "sessionEnded" });
		expect(ended.activeSubagents).toHaveLength(0);
		expect(ended.stopHeldForSubagents).toBe(false);

		const exited = statusReducer(held(), { kind: "ptyExited", code: 0 });
		expect(exited.activeSubagents).toHaveLength(0);
		expect(exited.stopHeldForSubagents).toBe(false);

		const escaped = statusReducer(held(), {
			kind: "keystroke",
			key: "esc",
			escRequired: 1,
			now: 2,
		});
		expect(escaped.state).toBe("idle");
		expect(escaped.activeSubagents).toHaveLength(0);
		expect(escaped.stopHeldForSubagents).toBe(false);
	});

	it("a late stop after the release never resurrects state", () => {
		const s = run(
			mk({ state: "working" }, "agent"),
			start("a", 0),
			mainStop(1),
			stop("a"),
			{ kind: "focus" }, // user acknowledges → idle
			stop("a"), // straggler duplicate
		);
		expect(s.state).toBe("idle");
	});
});
