import { describe, expect, it, vi } from "vitest";
import fixture from "../../lib/__tests__/fixtures/statusShadowStore.json";
import type { StatusView } from "../../lib/statusSync";

/** An op as `status_store.rs`'s replay reads it: what was sent, plus the
 *  store's view right after (`expected`). */
type ShadowOp = Record<string, unknown> & { op: string };

/**
 * The real `ptyActivityStore`, driven through seeded random sequences of its
 * own actions (including the paths that skip the reducer: initPty,
 * setShellCommandRunning, touchLastOutput, removePty) while fake time moves
 * and its idle scanner ticks. Every op shadow mode would send to Rust is
 * recorded in `fixtures/statusShadowStore.json`; `status_store.rs` replays
 * them and must find no difference. This is shadow mode run before the app
 * is (docs/plans/remote-hosts.md phase 3).
 *
 * Regenerate after a store change:
 * `UPDATE_STATUS_PARITY=1 npx vitest run src/stores/__tests__/statusShadowStore.test.ts`
 */

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

const RUNS = 40;
const STEPS = 40;
const NODE_FS = "node:fs";

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

interface RecordedChange {
	ptyId: string;
	prev: { state: string; detectionMode: string; hookDriven: boolean };
	next: { state: string; detectionMode: string; hookDriven: boolean };
	cause: unknown;
}

interface RecordedRun {
	ops: ShadowOp[];
	changes: RecordedChange[];
}

/** The store's legacy "active" is the reducer's (and Rust's) "working". */
function canonical(snap: {
	state: string;
	detectionMode: string;
	hookDriven: boolean;
}) {
	return { ...snap, state: snap.state === "active" ? "working" : snap.state };
}

async function record(): Promise<RecordedRun[]> {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	vi.resetModules();
	const sync = await import("../../lib/statusSync");
	const store = await import("../ptyActivityStore");
	const s = () => store.usePtyActivityStore.getState();
	const runs: RecordedRun[] = [];
	for (let r = 0; r < RUNS; r++) {
		const rand = prng(7000 + r);
		const ops: ShadowOp[] = [];
		const changes: RecordedChange[] = [];
		sync.__captureStatusOpsForTests((op) => {
			if (op.op === "tick") {
				const expected: Record<string, StatusView> = {};
				for (const id of Object.keys(s().activities)) {
					const v = store.__statusViewForTests(id);
					if (v) expected[id] = v;
				}
				ops.push({ op: "tick", now: op.now, expected });
			} else if (op.op === "remove") {
				ops.push({ ...op });
			} else {
				ops.push({ ...op, expected: store.__statusViewForTests(op.ptyId) });
			}
		});
		const unsubscribe = store.subscribeStatusChange((c) =>
			changes.push(
				structuredClone({
					ptyId: c.ptyId,
					prev: canonical(c.prev),
					next: canonical(c.next),
					cause: c.cause,
				}),
			),
		);
		const ptys = [`r${r}-a`, `r${r}-b`];
		for (let i = 0; i < STEPS; i++) {
			const p = pick(rand, ptys);
			const action = pick(rand, [
				"init",
				"init",
				"hook",
				"hook",
				"hook",
				"title",
				"titleEnded",
				"output",
				"touch",
				"shell",
				"markIdle",
				"click",
				"clearError",
				"recordError",
				"exitSuccess",
				"clearWaiting",
				"clearActive",
				"subStart",
				"subStop",
				"agent",
				"agentExit",
				"remove",
				"wait",
				"wait",
			] as const);
			switch (action) {
				case "init":
					s().initPty(p, pick(rand, ["agent", "shell", undefined] as const));
					break;
				case "hook":
					s().applyHookEvent(
						p,
						pick(rand, [
							"active",
							"waiting",
							"ready",
							"idle",
							"error",
							"errorMidTurn",
							"resume",
							"attach",
						] as const) as never,
						rand() < 0.3,
					);
					break;
				case "title":
					s().applyTitleStatus(
						p,
						pick(rand, ["working", "waiting", "none"] as const),
						rand() < 0.3,
					);
					break;
				case "titleEnded":
					s().titleTurnEnded(p);
					break;
				case "output":
					s().recordOutput(p);
					break;
				case "touch":
					store.touchLastOutput(p);
					break;
				case "shell":
					s().setShellCommandRunning(p, rand() < 0.5);
					break;
				case "markIdle":
					s().markIdle(p);
					break;
				case "click":
					s().click(p);
					break;
				case "clearError":
					s().clearError(p);
					break;
				case "recordError":
					s().recordError(p);
					break;
				case "exitSuccess":
					s().recordExitSuccess(p);
					break;
				case "clearWaiting":
					s().clearWaiting(p);
					break;
				case "clearActive":
					s().clearActive(p);
					break;
				case "subStart":
					s().subagentStarted(p, pick(rand, ["x", "y"]));
					break;
				case "subStop":
					s().subagentStopped(p, pick(rand, ["x", "y"]));
					break;
				case "agent":
					s().setAgentPty(p, pick(rand, ["claude", undefined] as const));
					break;
				case "agentExit":
					s().clearAgentPty(p);
					break;
				case "remove":
					s().removePty(p);
					break;
				case "wait":
					// Lets the scanner tick (every 2 s), sometimes past a backstop.
					vi.advanceTimersByTime(pick(rand, [500, 2000, 4100, 31_000]));
					break;
			}
			vi.advanceTimersByTime(pick(rand, [0, 10, 300]));
		}
		for (const p of ptys) s().removePty(p);
		unsubscribe();
		runs.push({ ops, changes });
	}
	sync.__captureStatusOpsForTests(null);
	vi.useRealTimers();
	return runs;
}

describe("status store shadow recording", () => {
	it("matches what the store does now", async () => {
		const runs = await record();
		expect(runs.some((r) => r.ops.some((op) => op.op === "tick"))).toBe(true);
		const proc = (
			globalThis as {
				process?: { env?: Record<string, string>; cwd(): string };
			}
		).process;
		if (proc?.env?.UPDATE_STATUS_PARITY) {
			const fs = (await import(/* @vite-ignore */ NODE_FS)) as {
				writeFileSync(path: string, data: string): void;
			};
			fs.writeFileSync(
				`${proc.cwd()}/src/lib/__tests__/fixtures/statusShadowStore.json`,
				`${JSON.stringify({ _comment: "Generated by statusShadowStore.test.ts; replayed by status_store.rs.", runs })}\n`,
			);
			return;
		}
		expect(runs).toEqual((fixture as { runs: RecordedRun[] }).runs);
	});
});
