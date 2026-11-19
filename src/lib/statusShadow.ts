import { isDemoMode } from "./demo";
import { statusShadowApi } from "./ipc";
import type { StatusEvent, StatusMode } from "./statusReducer";

/**
 * **Shadow mode** for the Rust status store (docs/plans/remote-hosts.md
 * phase 3, ADR-0063). In dev builds every operation that changes a PTY's
 * status in `ptyActivityStore` is also run in Rust (`status_store.rs`), with
 * the frontend's result; Rust reports any difference and it is logged here
 * as `[shadow] status differs`. The frontend store stays the authority until
 * these logs stay quiet in real use.
 *
 * Ops are batched per microtask and sent one batch at a time, so Rust sees
 * them in order. A reload of the Window can log differences for PTYs Rust
 * already knew; ignore those.
 */

/** What the frontend store keeps of a PTY's status (Rust's `StoreView`). */
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

export type ShadowOp =
	| {
			op: "init";
			ptyId: string;
			mode: StatusMode | null;
			expected: StatusView | null;
	  }
	| {
			op: "shellCommandRunning";
			ptyId: string;
			running: boolean;
			expected: StatusView | null;
	  }
	| {
			op: "apply";
			ptyId: string;
			event: StatusEvent;
			threshold: number | null;
			expected: StatusView | null;
	  }
	| { op: "tick"; now: number; expected: Record<string, StatusView> }
	| { op: "touch"; ptyId: string; now: number; expected: StatusView | null }
	| { op: "remove"; ptyId: string };

export const statusShadowEnabled =
	import.meta.env.DEV && import.meta.env.MODE !== "test" && !isDemoMode();

let queue: ShadowOp[] = [];
let scheduled = false;
let inFlight = false;

let capture: ((op: ShadowOp) => void) | null = null;

/** Test-only: receive every op instead of sending it to Rust, whatever the
 *  build (`statusShadowStore.test.ts` records them for the Rust replay). */
export function __captureShadowForTests(fn: ((op: ShadowOp) => void) | null) {
	capture = fn;
}

/** Mirror one operation to Rust (dev builds only). */
export function shadowStatus(op: ShadowOp): void {
	if (capture) {
		capture(structuredClone(op));
		return;
	}
	if (!statusShadowEnabled) return;
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
			try {
				const mismatches = await statusShadowApi.run(batch);
				for (const m of mismatches) {
					console.warn("[shadow] status differs (frontend vs Rust)", m);
				}
			} catch (e) {
				console.warn("[shadow] status shadow call failed", e);
			}
		}
	} finally {
		inFlight = false;
	}
}
