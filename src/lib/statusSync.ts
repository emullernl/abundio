import { isDemoMode } from "./demo";
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
}

export type StatusOp =
	| { op: "init"; ptyId: string; mode: StatusMode | null }
	| { op: "shellCommandRunning"; ptyId: string; running: boolean }
	| { op: "apply"; ptyId: string; event: StatusEvent }
	| { op: "touch"; ptyId: string; now: number }
	| { op: "remove"; ptyId: string }
	/** The pane's title showed a Title status (ADR-0047): until it has, Rust
	 *  drops a Title-status Agent's hooks, as the Window did. */
	| { op: "titleStatusSeen"; ptyId: string; seen: boolean };

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

/** The store registers how to apply Rust's updates (once, at module load). */
export function onStatusUpdate(fn: UpdateHandler): void {
	handler = fn;
	if (!isRustStatusAuthority()) return;
	ipc()
		.then(({ listenToThisWindow }) =>
			listenToThisWindow<StatusUpdate[]>("status-updates", (event) => {
				for (const u of event.payload) handler?.(u, true);
			}),
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
			for (const op of batch) {
				const left = (pending.get(op.ptyId) ?? 1) - 1;
				if (left > 0) pending.set(op.ptyId, left);
				else pending.delete(op.ptyId);
			}
			for (const u of updates) handler?.(u, false);
		}
	} finally {
		inFlight = false;
	}
}
