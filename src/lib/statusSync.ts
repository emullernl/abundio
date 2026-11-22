import { isDemoMode } from "./demo";
import { sentByOwnerOf } from "./hostRouting";
import type { StatusEvent, StatusMode } from "./statusReducer";

/**
 * The Window's link to the Rust status store, the authority for every pane's
 * status (ADR-0063, docs/plans/remote-hosts.md phase 3c).
 *
 * The Window still **predicts**: `ptyActivityStore` applies each change at
 * once, as before, so code that reads a status straight back keeps working.
 * Every change is also sent here, in order, and Rust's answer wins: when it
 * differs from the prediction the store takes Rust's version (and logs it).
 * The idle scan runs only in Rust; its changes arrive as `status-updates`.
 *
 * Tests and the browser demo have no Rust: there `isRustStatusAuthority()` is
 * false and the store runs its own idle scan, as it always did.
 */

/** What a pane's status is, as the store keeps it (Rust's `StoreView`). */
export interface StatusView {
	state: "idle" | "working" | "waiting" | "ready" | "error";
	mode: StatusMode;
	hookDriven: boolean;
	shellCommandRunning: boolean;
	workingSince: number | null;
	lastActivityAt: number | null;
	activeSubagents: ReadonlyArray<{ id: string; startedAt: number }>;
	stopHeldForSubagents: boolean;
	preErrorState: "working" | "waiting" | null;
	titleHeld: boolean;
}

export interface StatusSnapshotView {
	state: StatusView["state"];
	detectionMode: StatusMode;
	hookDriven: boolean;
}

/** One update from Rust for one pane (`StatusUpdate`). */
export interface StatusUpdate {
	ptyId: string;
	seq: number;
	view: StatusView | null;
	change: {
		prev: StatusSnapshotView;
		next: StatusSnapshotView;
		cause: StatusEvent;
	} | null;
	/** The latest change Rust made by itself (a hook, an exit, a title, the
	 *  idle scan) as of this update: its seq and cause. An answer showing one
	 *  the Window has not heard of yet is no sign of a wrong prediction. */
	hostSeq?: number | null;
	hostCause?: StatusEvent | null;
}

export type StatusOp =
	| { op: "init"; ptyId: string; mode: StatusMode | null }
	| { op: "shellCommandRunning"; ptyId: string; running: boolean }
	| { op: "apply"; ptyId: string; event: StatusEvent }
	| { op: "touch"; ptyId: string; now: number }
	| { op: "remove"; ptyId: string }
	/** Which Agent the PTY runs, as the Window detected it (its launch, the
	 *  command typed, a hook), or null when none: Rust reads that Agent's
	 *  Title status from the PTY's title (ADR-0047). */
	| { op: "agent"; ptyId: string; agentId: string | null };

/** Whether Rust is the authority here (not in tests or the browser demo). */
export function isRustStatusAuthority(): boolean {
	return import.meta.env.MODE !== "test" && !isDemoMode();
}

/** `ipc.ts`, loaded on first use: a static import would close a cycle
 *  (ipc → demo mocks → seed → ptyActivityStore → here) that lets the store
 *  run before this module has. */
function ipc(): Promise<typeof import("./ipc")> {
	return import("./ipc");
}

type UpdateHandler = (update: StatusUpdate, fromScan: boolean) => void;

let handler: UpdateHandler | null = null;
let queue: StatusOp[] = [];
let scheduled = false;
let inFlight = false;
/** Ops sent but not yet answered, per pane: Rust's answer is only compared
 *  with the prediction once the pane has none left in flight. */
const pending = new Map<string, number>();

/** Whether `ptyId` has changes on their way to Rust. */
export function hasPendingStatusOps(ptyId: string): boolean {
	return (pending.get(ptyId) ?? 0) > 0;
}

let settledHandler: ((ptyId: string) => void) | null = null;

/** The store registers what to do once a pane has nothing in flight. */
export function onStatusSettled(fn: (ptyId: string) => void): void {
	settledHandler = fn;
}

/** The store registers how to apply Rust's updates (once, at module load). */
export function onStatusUpdate(fn: UpdateHandler): void {
	handler = fn;
	if (!isRustStatusAuthority()) return;
	ipc()
		.then(({ listenToThisWindow }) =>
			listenToThisWindow<(StatusUpdate & { fromHost?: string })[]>(
				"status-updates",
				(event) => {
					for (const u of event.payload) {
						// A Host reports only its own PTYs (ADR-0065).
						if (sentByOwnerOf(u.fromHost, "pty", u.ptyId, { unknownOk: true }))
							handler?.(u, true);
					}
				},
			),
		)
		.catch((e) => console.warn("[status] cannot hear Rust's idle scan", e));
}

type CapturedOp = StatusOp | { op: "tick"; now: number };

let capture: ((op: CapturedOp) => void) | null = null;

/** Test-only: receive every op instead of sending it to Rust, whatever the
 *  build, plus each local idle scan (`statusShadowStore.test.ts` records
 *  them for the Rust replay). */
export function __captureStatusOpsForTests(
	fn: ((op: CapturedOp) => void) | null,
): void {
	capture = fn;
}

/** The store's own idle scan ran (tests and demo only). */
export function recordScanTickForTests(now: number): void {
	capture?.({ op: "tick", now });
}

/** Send one status change to Rust (only where Rust is the authority). */
export function sendStatusOp(op: StatusOp): void {
	if (capture) {
		capture(structuredClone(op));
		return;
	}
	if (!isRustStatusAuthority()) return;
	pending.set(op.ptyId, (pending.get(op.ptyId) ?? 0) + 1);
	queue.push(op);
	if (!scheduled && !inFlight) {
		scheduled = true;
		queueMicrotask(flush);
	}
}

async function flush(): Promise<void> {
	scheduled = false;
	if (inFlight) return;
	inFlight = true;
	try {
		while (queue.length > 0) {
			const batch = queue;
			queue = [];
			let updates: StatusUpdate[] = [];
			try {
				updates = await (await ipc()).statusApi.apply(batch);
			} catch (e) {
				console.warn("[status] Rust did not take the changes", e);
			}
			const settled = new Set<string>();
			for (const op of batch) {
				const left = (pending.get(op.ptyId) ?? 1) - 1;
				if (left > 0) {
					pending.set(op.ptyId, left);
				} else {
					pending.delete(op.ptyId);
					settled.add(op.ptyId);
				}
			}
			for (const u of updates) handler?.(u, false);
			// A change that changed nothing in Rust has no answer: what was
			// held back while it was in flight must not wait for one.
			for (const ptyId of settled) {
				if (!pending.has(ptyId)) settledHandler?.(ptyId);
			}
		}
	} finally {
		inFlight = false;
	}
}
