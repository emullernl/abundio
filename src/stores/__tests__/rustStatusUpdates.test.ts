import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusUpdate, StatusView } from "../../lib/statusSync";

const pending = vi.hoisted(() => ({ ids: new Set<string>() }));

vi.mock("../../lib/statusSync", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../lib/statusSync")>();
	return {
		...real,
		hasPendingStatusOps: (id: string) => pending.ids.has(id),
	};
});
vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
	onAction: vi.fn(),
}));
vi.mock("../../lib/notificationRouter", () => ({
	findPaneLocation: vi.fn(() => null),
	isPaneVisible: vi.fn(() => false),
}));
vi.mock("../../lib/windowFocus", () => ({
	isAppWindowFocused: () => true,
	getWindowBlurredMs: () => null,
	addWindowFocusListener: () => () => {},
	NOTIFICATION_BLUR_THRESHOLD_MS: 3000,
}));

import {
	__statusViewForTests,
	applyRustUpdate,
	type StatusChange,
	subscribeStatusChange,
	usePtyActivityStore,
} from "../ptyActivityStore";

let seq = 0;
function update(
	ptyId: string,
	view: StatusView | null,
	change: StatusUpdate["change"] = null,
): StatusUpdate {
	seq += 1;
	return { ptyId, seq, view, change };
}

function workingAgent(now: number): void {
	const s = usePtyActivityStore.getState();
	s.initPty("p", "agent");
	s.applyHookEvent("p", "active", true);
	void now;
}

describe("applying Rust's status updates", () => {
	let changes: StatusChange[];
	let unsubscribe: () => void;

	beforeEach(() => {
		usePtyActivityStore.getState().removePty("p");
		pending.ids.clear();
		changes = [];
		unsubscribe?.();
		unsubscribe = subscribeStatusChange((c) => changes.push(c));
	});

	it("does nothing when Rust agrees with the prediction", () => {
		workingAgent(1);
		changes = [];
		const view = __statusViewForTests("p");
		applyRustUpdate(update("p", view), false);
		expect(changes).toEqual([]);
		expect(__statusViewForTests("p")).toEqual(view);
	});

	it("takes and announces a change from Rust's idle scan", () => {
		workingAgent(1);
		changes = [];
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		const ready: StatusView = { ...view, state: "ready" };
		applyRustUpdate(
			update("p", ready, {
				prev: { state: "working", detectionMode: "agent", hookDriven: true },
				next: { state: "ready", detectionMode: "agent", hookDriven: true },
				cause: { kind: "tick", now: 99, rule: "idle_backstop" },
			}),
			true,
		);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("ready");
		expect(changes).toHaveLength(1);
		expect(changes[0].prev.state).toBe("active");
		expect(changes[0].next.state).toBe("ready");
		expect(changes[0].cause).toEqual({
			kind: "tick",
			now: 99,
			rule: "idle_backstop",
		});
	});

	it("corrects a wrong prediction and says so", () => {
		workingAgent(1);
		changes = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		applyRustUpdate(
			update(
				"p",
				{ ...view, state: "waiting" },
				{
					prev: { state: "idle", detectionMode: "agent", hookDriven: false },
					next: { state: "waiting", detectionMode: "agent", hookDriven: true },
					cause: { kind: "hook", transition: "waiting", now: 5 },
				},
			),
			false,
		);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("waiting");
		expect(changes.map((c) => c.next.state)).toEqual(["waiting"]);
		expect(warn).toHaveBeenCalledWith(
			'[status] Rust corrected the Window\'s status (state: "working" → "waiting"; cause hook)',
			expect.anything(),
		);
		warn.mockRestore();
	});

	it("takes quietly an answer that overtook a change Rust made itself", () => {
		workingAgent(1);
		changes = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		const title = {
			kind: "title" as const,
			status: "none" as const,
			now: 5,
			startsTurn: false,
		};
		// Rust's own title change is seq N; the answer to the Window's focus
		// (seq N+1) arrives first and already shows it.
		const hostSeq = seq + 1;
		seq += 1;
		const answer = {
			...update(
				"p",
				{ ...view, state: "idle" },
				{
					prev: { state: "working", detectionMode: "agent", hookDriven: true },
					next: { state: "idle", detectionMode: "agent", hookDriven: true },
					cause: { kind: "focus" },
				},
			),
			hostSeq,
			hostCause: title,
		};
		applyRustUpdate(answer, false);
		expect(warn).not.toHaveBeenCalled();
		expect(changes.map((c) => c.cause)).toEqual([title]);
		// The overtaken event, when it lands, changes nothing.
		applyRustUpdate(
			{
				...update("p", { ...view, state: "idle" }, answer.change),
				seq: hostSeq,
			},
			true,
		);
		expect(changes).toHaveLength(1);
		// Once heard, a later difference is a correction again.
		applyRustUpdate(
			{
				...update("p", { ...view, state: "waiting" }),
				hostSeq,
				hostCause: title,
			},
			false,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("takes a different activity time alone without calling it a correction", () => {
		workingAgent(1);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		applyRustUpdate(update("p", { ...view, lastActivityAt: 12345 }), false);
		expect(warn).not.toHaveBeenCalled();
		expect(__statusViewForTests("p")?.lastActivityAt).toBe(12345);
		warn.mockRestore();
	});

	it("keeps a change held back while in flight when the answer comes in older", () => {
		usePtyActivityStore.getState().initPty("p", "shell");
		changes = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		// Enter is in flight; Rust answered it (seq N), then saw the command
		// start (seq N+1), and N+1 arrives first.
		pending.ids.add("p");
		const answer = update("p", view);
		const started = update(
			"p",
			{ ...view, state: "working", shellCommandRunning: true },
			{
				prev: { state: "idle", detectionMode: "shell", hookDriven: false },
				next: { state: "working", detectionMode: "shell", hookDriven: false },
				cause: { kind: "recordOutput", now: 7 },
			},
		);
		applyRustUpdate(started, true);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("idle");
		pending.ids.clear();
		applyRustUpdate(answer, false);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("active");
		expect(changes.map((c) => c.cause)).toEqual([
			{ kind: "recordOutput", now: 7 },
		]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("never applies an older update over a newer one", () => {
		workingAgent(1);
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		const newer = update("p", view);
		const older = { ...update("p", { ...view, state: "error" }), seq: 1 };
		applyRustUpdate(newer, false);
		applyRustUpdate(older, true);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("active");
	});

	it("waits while the pane has changes in flight, then applies with the scan's cause", () => {
		workingAgent(1);
		changes = [];
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		pending.ids.add("p");
		applyRustUpdate(
			update(
				"p",
				{ ...view, state: "ready" },
				{
					prev: { state: "working", detectionMode: "agent", hookDriven: true },
					next: { state: "ready", detectionMode: "agent", hookDriven: true },
					cause: { kind: "tick", now: 50, rule: "idle_backstop" },
				},
			),
			true,
		);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("active");
		pending.ids.clear();
		// The answer to the in-flight change carries the scan's effect.
		applyRustUpdate(update("p", { ...view, state: "ready" }), false);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("ready");
		expect(changes).toHaveLength(1);
		expect(changes[0].cause).toEqual({
			kind: "tick",
			now: 50,
			rule: "idle_backstop",
		});
	});

	it("credits the scan, not the Window's own change, when the scan landed in between", () => {
		workingAgent(1);
		changes = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const view = __statusViewForTests("p");
		if (!view) throw new Error("no view");
		pending.ids.add("p");
		const tick = {
			kind: "tick",
			now: 50,
			rule: "idle_backstop",
		} as const;
		applyRustUpdate(
			update(
				"p",
				{ ...view, state: "ready" },
				{
					prev: { state: "working", detectionMode: "agent", hookDriven: true },
					next: { state: "ready", detectionMode: "agent", hookDriven: true },
					cause: tick,
				},
			),
			true,
		);
		pending.ids.clear();
		// The answer to the Window's change (a title the Window also applied)
		// carries a change of its own, and the scan's effect.
		applyRustUpdate(
			update(
				"p",
				{ ...view, state: "ready", titleHeld: true },
				{
					prev: { state: "working", detectionMode: "agent", hookDriven: true },
					next: { state: "ready", detectionMode: "agent", hookDriven: true },
					cause: {
						kind: "title",
						status: "working",
						focused: false,
						now: 49,
					} as never,
				},
			),
			false,
		);
		expect(usePtyActivityStore.getState().activities.p.state).toBe("ready");
		expect(changes.map((c) => c.cause)).toEqual([tick]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
