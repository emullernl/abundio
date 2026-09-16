import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import {
	blocksQuit,
	buildWindowCloseMessage,
	busyCounts,
	describeBusy,
	hasBusyWork,
	isBusyPty,
	NO_BUSY,
	sumBusyCounts,
} from "../busyPty";

function entry(
	state: PtyActivityEntry["state"],
	detectionMode: PtyActivityEntry["detectionMode"],
	shellCommandRunning = false,
): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode,
		hookDriven: false,
		shellCommandRunning,
	};
}

describe("isBusyPty", () => {
	// Every combination that can reach the predicate. An agent is Busy on
	// `active` alone; a shell only on its command flag, whatever its icon says.
	const cases: Array<[PtyActivityEntry, boolean, string]> = [
		[entry("active", "agent"), true, "Working agent"],
		[entry("waiting", "agent"), false, "Waiting agent is blocked on the user"],
		[entry("ready", "agent"), false, "Ready agent has finished"],
		[entry("idle", "agent"), false, "Idle agent"],
		[entry("error", "agent"), false, "failed agent is not still working"],
		[entry("active", "shell", true), true, "shell running a command"],
		[
			entry("active", "shell", false),
			false,
			"shell drawn Working with no command in flight",
		],
		[
			entry("idle", "shell", true),
			true,
			"silent long build: still busy though the icon has gone quiet",
		],
		[entry("idle", "shell"), false, "idle shell"],
		[entry("error", "shell"), false, "shell that exited non-zero"],
	];

	for (const [e, expected, why] of cases) {
		it(`${expected ? "is" : "is not"} busy: ${why}`, () => {
			expect(isBusyPty(e)).toBe(expected);
		});
	}

	it("is not busy for an unknown PTY", () => {
		expect(isBusyPty(undefined)).toBe(false);
	});
});

describe("busyCounts", () => {
	it("tallies each kind separately", () => {
		expect(
			busyCounts({
				a: entry("active", "agent"),
				b: entry("active", "agent"),
				c: entry("waiting", "agent"),
				d: entry("idle", "agent"),
				e: entry("active", "shell", true),
				f: entry("idle", "shell"),
			}),
		).toEqual({ working: 2, waiting: 1, commands: 1 });
	});

	it("is all zeroes for an empty Window", () => {
		expect(busyCounts({})).toEqual(NO_BUSY);
	});

	it("never counts an agent's shellCommandRunning", () => {
		// Agent mode emits no command_end, so a stale flag there must not leak
		// into the command tally.
		expect(busyCounts({ a: entry("idle", "agent", true) })).toEqual(NO_BUSY);
	});
});

describe("hasBusyWork / blocksQuit", () => {
	it("treats a Waiting agent as quit-blocking but not Busy", () => {
		const c = { working: 0, waiting: 1, commands: 0 };
		expect(hasBusyWork(c)).toBe(false);
		expect(blocksQuit(c)).toBe(true);
	});

	it("agrees on Working agents and running commands", () => {
		for (const c of [
			{ working: 1, waiting: 0, commands: 0 },
			{ working: 0, waiting: 0, commands: 1 },
		]) {
			expect(hasBusyWork(c)).toBe(true);
			expect(blocksQuit(c)).toBe(true);
		}
	});

	it("is quiet when nothing is busy", () => {
		expect(hasBusyWork(NO_BUSY)).toBe(false);
		expect(blocksQuit(NO_BUSY)).toBe(false);
	});
});

describe("sumBusyCounts", () => {
	it("adds each field across Windows", () => {
		expect(
			sumBusyCounts([
				{ working: 1, waiting: 0, commands: 2 },
				{ working: 0, waiting: 3, commands: 1 },
			]),
		).toEqual({ working: 1, waiting: 3, commands: 3 });
	});
});

describe("describeBusy", () => {
	it("names one clause", () => {
		expect(describeBusy({ working: 1, waiting: 0, commands: 0 })).toBe(
			"1 agent working",
		);
	});

	it("joins every clause, most urgent first", () => {
		expect(describeBusy({ working: 2, waiting: 1, commands: 3 })).toBe(
			"2 agents working, 1 agent waiting on you and 3 running commands",
		);
	});

	it("omits zero counts", () => {
		expect(describeBusy({ working: 0, waiting: 0, commands: 1 })).toBe(
			"1 running command",
		);
	});

	it("is empty when nothing is busy, which callers read as 'no dialog'", () => {
		expect(describeBusy(NO_BUSY)).toBe("");
	});
});

describe("buildWindowCloseMessage", () => {
	it("names what will be terminated", () => {
		expect(
			buildWindowCloseMessage({ working: 1, waiting: 0, commands: 2 }),
		).toBe(
			"This window has 1 agent working and 2 running commands. Closing it will terminate them.",
		);
	});
});
