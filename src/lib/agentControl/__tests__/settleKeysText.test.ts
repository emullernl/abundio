import { describe, expect, it } from "vitest";
import type { PtyActivityState } from "../../types";
import { keyBytes, keysToBytes } from "../keys";
import { cleanPromptText } from "../promptText";
import {
	isStalled,
	type PaneSnapshot,
	STALL_MS,
	type WaitGoal,
	type WaitProgress,
	waitStep,
} from "../settle";

const agent = (state: PtyActivityState): PaneSnapshot => ({
	state,
	mode: "agent",
	gone: false,
});

function run(goal: WaitGoal, snaps: PaneSnapshot[]): WaitProgress {
	let p: WaitProgress = { sawWorking: false, end: null };
	for (const s of snaps) p = waitStep(goal, p, s);
	return p;
}

const prompted: WaitGoal = { until: "settled", needWorking: true };
const plain: WaitGoal = { until: "settled", needWorking: false };

describe("waitStep after a prompt", () => {
	it("Working → Ready settles as ready", () => {
		expect(
			run(prompted, [agent("ready"), agent("active"), agent("ready")]).end,
		).toBe("ready");
	});

	it("Working → Waiting settles as waiting", () => {
		expect(
			run(prompted, [agent("idle"), agent("active"), agent("waiting")]).end,
		).toBe("waiting");
	});

	it("Working → Error settles as error", () => {
		expect(run(prompted, [agent("active"), agent("error")]).end).toBe("error");
	});

	it("does not take the Ready left over from the last turn", () => {
		const p = run(prompted, [agent("ready"), agent("ready")]);
		expect(p.end).toBeNull();
		expect(isStalled(prompted, p, STALL_MS - 1)).toBe(false);
		expect(isStalled(prompted, p, STALL_MS)).toBe(true);
	});

	it("counts Working already under way at the start", () => {
		const p = run(prompted, [agent("active")]);
		expect(p.sawWorking).toBe(true);
		expect(isStalled(prompted, p, STALL_MS * 10)).toBe(false);
		expect(waitStep(prompted, p, agent("ready")).end).toBe("ready");
	});

	it("ends as left when the Agent quits or the pane goes", () => {
		expect(
			run(prompted, [
				agent("active"),
				{ state: "idle", mode: "shell", gone: false },
			]).end,
		).toBe("left");
		expect(
			run(prompted, [agent("active"), { ...agent("active"), gone: true }]).end,
		).toBe("left");
	});
});

describe("waitStep without a prompt", () => {
	it("ends at once when already Settled", () => {
		expect(run(plain, [agent("ready")]).end).toBe("ready");
	});

	it("waits through Idle and Working", () => {
		expect(run(plain, [agent("idle"), agent("active")]).end).toBeNull();
		expect(
			run(plain, [agent("idle"), agent("active"), agent("waiting")]).end,
		).toBe("waiting");
	});

	it("with --until, only that state ends it", () => {
		const g: WaitGoal = { until: "ready", needWorking: false };
		expect(run(g, [agent("waiting"), agent("error")]).end).toBeNull();
		expect(run(g, [agent("waiting"), agent("ready")]).end).toBe("ready");
	});

	it("never stalls", () => {
		expect(isStalled(plain, run(plain, [agent("idle")]), STALL_MS * 10)).toBe(
			false,
		);
	});

	it("stays ended", () => {
		const p = run(plain, [agent("ready")]);
		expect(waitStep(plain, p, { state: null, mode: null, gone: true })).toBe(p);
	});
});

describe("keys", () => {
	it("maps named keys", () => {
		expect(keyBytes("enter", false)).toBe("\r");
		expect(keyBytes("esc", false)).toBe("\x1b");
		expect(keyBytes("shift+tab", false)).toBe("\x1b[Z");
		expect(keyBytes("backspace", false)).toBe("\x7f");
		expect(keyBytes("pagedown", false)).toBe("\x1b[6~");
	});

	it("follows application cursor mode for arrows, Home and End", () => {
		expect(keyBytes("up", false)).toBe("\x1b[A");
		expect(keyBytes("up", true)).toBe("\x1bOA");
		expect(keyBytes("end", true)).toBe("\x1bOF");
	});

	it("maps ctrl+letter to its control code", () => {
		expect(keyBytes("ctrl+c", false)).toBe("\x03");
		expect(keyBytes("ctrl+a", false)).toBe("\x01");
		expect(keyBytes("ctrl+z", false)).toBe("\x1a");
	});

	it("sends nothing when any name is unknown", () => {
		expect(keysToBytes(["esc", "enter"], false)).toEqual({
			ok: true,
			bytes: "\x1b\r",
		});
		expect(keysToBytes(["esc", "f13"], false)).toEqual({
			ok: false,
			unknown: "f13",
		});
	});

	it("covers every key Rust accepts", () => {
		const named = [
			"enter",
			"esc",
			"tab",
			"shift+tab",
			"backspace",
			"delete",
			"space",
			"up",
			"down",
			"left",
			"right",
			"home",
			"end",
			"pageup",
			"pagedown",
		];
		for (const k of named) expect(keyBytes(k, false)).not.toBeNull();
	});
});

describe("cleanPromptText", () => {
	it("keeps newlines and tabs", () => {
		expect(cleanPromptText("one\n\ttwo")).toBe("one\n\ttwo");
	});

	it("drops an embedded paste end and other controls", () => {
		expect(cleanPromptText("hi\x1b[201~rm -rf ~\x07\x00")).toBe(
			"hi[201~rm -rf ~",
		);
		expect(cleanPromptText("a\u009bb\x7f")).toBe("ab");
	});

	it("turns CR and CRLF into newlines", () => {
		expect(cleanPromptText("a\r\nb\rc")).toBe("a\nb\nc");
	});
});
