import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const write = vi.fn(async () => {});
vi.mock("../../ipc", () => ({
	agentControl: {
		handleCheck: async () => ({ ok: true }),
		handleDefault: async () => "Agent One",
		paneNumbers: async (_ws: string, ids: string[]) =>
			ids.map((id, i) => [id, i + 1]),
	},
	tabs: { update: async () => {} },
	pty: { write: (...a: unknown[]) => write(...(a as [])) },
}));

const terminals = new Map<string, unknown>();
vi.mock("../../terminalManager", () => ({
	getTerminal: (id: string) => terminals.get(id),
	startPtyUnlessShown: () => () => {},
}));

import type { PtyActivityEntry } from "../../../stores/ptyActivityStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import type { PtyActivityState, WorkspaceWithTabs } from "../../types";
import { runRequest } from "../handleControlRequest";

const caller = { ptyId: "pty-a", paneId: "a", workspaceId: "ws" };
const layout = {
	type: "split",
	id: "s",
	direction: "horizontal",
	ratio: 0.5,
	first: { type: "terminal", id: "a", ptyId: "pty-a" },
	second: { type: "terminal", id: "b", ptyId: "pty-b", agentId: "claude" },
};
const target = { kind: "pane", value: 2 } as const;

let input: string[];
let pasted: string[];
let focused: number;

function setB(state: PtyActivityState, mode: "agent" | "shell" = "agent") {
	usePtyActivityStore.setState((s) => ({
		activities: {
			...s.activities,
			"pty-b": {
				state,
				detectionMode: mode,
				lastOutputAt: null,
				hasEverReceivedOutput: true,
				hookDriven: true,
				shellCommandRunning: false,
			} as PtyActivityEntry,
		},
	}));
}

beforeEach(() => {
	vi.useFakeTimers();
	write.mockClear();
	input = [];
	pasted = [];
	focused = 0;
	terminals.clear();
	terminals.set("b", {
		ptyId: "pty-b",
		term: {
			modes: { applicationCursorKeysMode: true },
			paste: (t: string) => pasted.push(t),
			input: (t: string) => input.push(t),
			focus: () => focused++,
		},
	});
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws",
				tabs: [
					{
						id: "t",
						workspaceId: "ws",
						name: "Main",
						layoutJson: JSON.stringify(layout),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			} as unknown as WorkspaceWithTabs,
		],
		ptyStatuses: {},
	});
	setB("ready");
});

afterEach(() => vi.useRealTimers());

const prompt = (text: string, wait: boolean) =>
	runRequest(caller, {
		op: "agent.prompt",
		target,
		text,
		wait,
		timeoutMs: null,
	});

describe("agent prompt", () => {
	it("pastes the cleaned text, presses Enter, and leaves focus alone", async () => {
		const r = await prompt("fix it\x1b[201~\nplease", false);
		expect(pasted).toEqual(["fix it[201~\nplease"]);
		expect(input).toEqual(["\r"]);
		expect(focused).toBe(0);
		expect(r).toEqual({ pane: "p2", sent: true });
	});

	it("refuses while the Agent is Waiting, sending nothing", async () => {
		setB("waiting");
		await expect(prompt("hi", false)).rejects.toMatchObject({ code: "busy" });
		expect(pasted).toEqual([]);
	});

	it("refuses a shell pane", async () => {
		setB("idle", "shell");
		await expect(prompt("hi", false)).rejects.toMatchObject({
			code: "not_an_agent",
		});
	});

	it("refuses a prompt that is only control characters", async () => {
		await expect(prompt("\x1b\x07", false)).rejects.toMatchObject({
			code: "empty_prompt",
		});
	});

	it("with --wait, answers once the Agent has worked and settled", async () => {
		const p = prompt("go", true);
		await vi.advanceTimersByTimeAsync(300);
		setB("active");
		await vi.advanceTimersByTimeAsync(300);
		setB("ready");
		await vi.advanceTimersByTimeAsync(300);
		await expect(p).resolves.toMatchObject({
			pane: "p2",
			sent: true,
			status: "ready",
		});
	});

	it("with --wait, reports stalled when the Agent never starts", async () => {
		const p = prompt("go", true);
		const settled = expect(p).rejects.toMatchObject({ code: "stalled" });
		await vi.advanceTimersByTimeAsync(5300);
		await settled;
	});
});

describe("agent wait", () => {
	it("answers at once when already Settled", async () => {
		await expect(
			runRequest(caller, {
				op: "agent.wait",
				target,
				until: "settled",
				timeoutMs: null,
			}),
		).resolves.toMatchObject({ status: "ready" });
	});

	it("stops when Rust cancels it", async () => {
		setB("active");
		const abort = new AbortController();
		const p = runRequest(
			caller,
			{ op: "agent.wait", target, until: "settled", timeoutMs: null },
			abort.signal,
		);
		const settled = expect(p).rejects.toThrow("cancelled");
		await vi.advanceTimersByTimeAsync(300);
		abort.abort();
		await settled;
	});

	it("reports exited when the Agent quits", async () => {
		setB("active");
		const p = runRequest(caller, {
			op: "agent.wait",
			target,
			until: "settled",
			timeoutMs: null,
		});
		await vi.advanceTimersByTimeAsync(300);
		setB("idle", "shell");
		await vi.advanceTimersByTimeAsync(300);
		await expect(p).resolves.toMatchObject({ status: "exited" });
	});
});

describe("agent send-keys", () => {
	it("writes the keys' bytes to the PTY in one go", async () => {
		const r = await runRequest(caller, {
			op: "agent.sendKeys",
			target,
			keys: ["esc", "up", "ctrl+c", "enter"],
		});
		expect(write).toHaveBeenCalledWith("pty-b", "\x1b\x1bOA\x03\r");
		expect(r).toEqual({ pane: "p2", sent: 4 });
	});

	it("sends nothing if any key is unknown", async () => {
		await expect(
			runRequest(caller, {
				op: "agent.sendKeys",
				target,
				keys: ["esc", "f13"],
			}),
		).rejects.toMatchObject({ code: "internal" });
		expect(write).not.toHaveBeenCalled();
	});
});
