import { describe, expect, it } from "vitest";
import {
	eventStartsTurn,
	initialStatusState,
	type StatusEvent,
	type StatusMode,
	type StatusState,
	statusReducer,
} from "../statusReducer";
import fixture from "./fixtures/statusParity.json";

/**
 * Parity between this reducer and its Rust port (`status_machine.rs`,
 * ADR-0063). Random but seeded event sequences run through the reducer here;
 * every state is stored in `fixtures/statusParity.json`, which the Rust test
 * replays and must match.
 *
 * This test fails when the reducer changes behaviour, because the fixture no
 * longer matches. Then change the Rust port the same way and regenerate:
 * `UPDATE_STATUS_PARITY=1 npx vitest run src/lib/__tests__/statusParity.test.ts`.
 */

const RUNS = 120;
// A variable, so the type checker (no Node types here) does not resolve it.
const NODE_FS = "node:fs";
const STEPS = 20;

function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)];
}

const TRANSITIONS = [
	"working",
	"waiting",
	"ready",
	"idle",
	"error",
	"errorMidTurn",
	"resume",
	"attach",
] as const;

function randomEvent(rand: () => number, now: number): StatusEvent {
	const kinds = [
		"hook",
		"hook",
		"hook",
		"agentDetected",
		"agentExited",
		"shellCommandStarted",
		"shellCommandEnded",
		"output",
		"output",
		"keystroke",
		"keystroke",
		"subagentStarted",
		"subagentStopped",
		"title",
		"titleTurnEnded",
		"ptyExited",
		"tick",
		"tick",
		"focus",
		"click",
		"recordOutput",
		"recordError",
		"recordExitSuccess",
		"clearError",
		"clearWaiting",
		"clearActive",
	] as const;
	const exit = () => pick(rand, [0, 1, 2, 130, 143, null, undefined]);
	switch (pick(rand, kinds)) {
		case "hook":
			return {
				kind: "hook",
				transition: pick(rand, TRANSITIONS),
				now,
				...(rand() < 0.3 ? { startsTurn: true } : {}),
			};
		case "agentDetected":
			return { kind: "agentDetected" };
		case "agentExited":
			return { kind: "agentExited" };
		case "shellCommandStarted":
			return { kind: "shellCommandStarted", now };
		case "shellCommandEnded":
			return { kind: "shellCommandEnded", exit: exit() };
		case "output":
			return {
				kind: "output",
				bytes: pick(rand, [10, 300, 1024, 2000, 5000]),
				now,
			};
		case "keystroke":
			return {
				kind: "keystroke",
				key: pick(rand, ["esc", "answer", "other"] as const),
				escRequired: pick(rand, [1, 2]),
				now,
			};
		case "subagentStarted":
			return {
				kind: "subagentStarted",
				agentId: pick(rand, ["a", "b"]),
				now,
			};
		case "subagentStopped":
			return {
				kind: "subagentStopped",
				agentId: pick(rand, ["a", "b", "c"]),
				now,
			};
		case "title":
			return {
				kind: "title",
				status: pick(rand, ["working", "waiting", "none"] as const),
				now,
				...(rand() < 0.3 ? { startsTurn: true } : {}),
			};
		case "titleTurnEnded":
			return { kind: "titleTurnEnded", now };
		case "ptyExited": {
			const code = exit();
			return { kind: "ptyExited", code: code ?? null };
		}
		case "tick":
			return { kind: "tick", now };
		case "focus":
			return { kind: "focus" };
		case "click":
			return { kind: "click" };
		case "recordOutput":
			return { kind: "recordOutput", now };
		case "recordError":
			return { kind: "recordError" };
		case "recordExitSuccess":
			return { kind: "recordExitSuccess" };
		case "clearError":
			return { kind: "clearError" };
		case "clearWaiting":
			return { kind: "clearWaiting" };
		case "clearActive":
			return { kind: "clearActive" };
	}
}

/** Half the time, an event that matters in the current state, so the narrow
 *  rules (double ESC, answering Waiting, a held Stop draining, the input gate)
 *  are reached often enough to be checked. */
function focusedEvent(
	rand: () => number,
	s: StatusState,
	now: number,
): StatusEvent | null {
	if (rand() < 0.5) return null;
	if (s.mode === "agent" && s.state === "working") {
		return pick(rand, [
			{ kind: "keystroke", key: "esc", escRequired: 2, now },
			{ kind: "keystroke", key: "esc", escRequired: 2, now },
			{ kind: "hook", transition: "ready", now },
			{ kind: "subagentStopped", agentId: "a", now },
			{ kind: "tick", now },
		] as StatusEvent[]);
	}
	if (s.mode === "agent" && s.state === "waiting") {
		return pick(rand, [
			{ kind: "keystroke", key: "answer", escRequired: 2, now },
			{ kind: "hook", transition: "resume", now },
			{ kind: "click" },
		] as StatusEvent[]);
	}
	if (s.mode === "agent" && s.state === "error") {
		return pick(rand, [
			{ kind: "hook", transition: "errorMidTurn", now },
			{ kind: "keystroke", key: "other", escRequired: 1, now },
		] as StatusEvent[]);
	}
	if (s.mode === "agent" && !s.hookDriven) {
		return { kind: "output", bytes: 2000, now };
	}
	return null;
}

interface Run {
	mode: StatusMode;
	threshold: number;
	steps: { event: StatusEvent; state: StatusState; startsTurn: boolean }[];
}

function generate(): { runs: Run[] } {
	const runs: Run[] = [];
	for (let r = 0; r < RUNS; r++) {
		const rand = prng(1000 + r);
		const mode: StatusMode = rand() < 0.7 ? "agent" : "shell";
		const threshold = pick(rand, [512, 1024, 4096]);
		let state = initialStatusState(mode);
		let now = 1_000_000;
		const steps: Run["steps"] = [];
		for (let i = 0; i < STEPS; i++) {
			now += pick(rand, [0, 50, 400, 700, 800, 2100, 3500, 31_000, 7_300_000]);
			const event = focusedEvent(rand, state, now) ?? randomEvent(rand, now);
			state = statusReducer(state, event, {
				activityByteThreshold: threshold,
			});
			// JSON round trip: what the file holds (undefined fields vanish).
			steps.push(
				JSON.parse(
					JSON.stringify({ event, state, startsTurn: eventStartsTurn(event) }),
				),
			);
		}
		runs.push({ mode, threshold, steps });
	}
	return { runs };
}

describe("status reducer parity fixture", () => {
	it("matches what the reducer does now", async () => {
		const generated = generate();
		const proc = (
			globalThis as {
				process?: { env?: Record<string, string>; cwd(): string };
			}
		).process;
		const env = proc?.env;
		if (env?.UPDATE_STATUS_PARITY) {
			const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
				writeFileSync(path: string, data: string): void;
			};
			fs.writeFileSync(
				`${proc?.cwd()}/src/lib/__tests__/fixtures/statusParity.json`,
				`${JSON.stringify({ _comment: "Generated by statusParity.test.ts; replayed by status_machine.rs.", ...generated })}\n`,
			);
			return;
		}
		expect(generated.runs).toEqual((fixture as { runs: Run[] }).runs);
	});
});
