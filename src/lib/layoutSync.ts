import { isDemoMode } from "./demo";
import { diffLayout, type LayoutOp, sameLayout } from "./layoutOps";
import { parseTabLayout } from "./paneTree";

/**
 * The Window's link to the Rust layout store, the authority for every Tab's
 * layout (ADR-0063, docs/plans/remote-hosts.md phase 4).
 *
 * The Window still **predicts**: `workspaceStore` shows each edit at once, as
 * before. The edit is also diffed against what Rust last had (`base`) and
 * sent as ops (`layout_apply`), one batch at a time. Rust's answer wins: when
 * it differs from `base` (another Client's edit got there first, or an op
 * named a pane that is gone) the store takes Rust's layout. Other Windows'
 * edits arrive as `layout-changed`.
 *
 * A Tab's first edit in this Window is sent whole (`set`): the Window's copy
 * was cleaned on load (dead PTYs, orphan previews) and Rust's was not.
 *
 * Tests and the browser demo have no Rust: there `isRustLayoutAuthority()`
 * is false and the store saves with `tab_update`, as it always did.
 */

/** A Tab's layout as Rust now has it (`LayoutState` in `layout_store.rs`). */
export interface LayoutState {
	tabId: string;
	version: number;
	layoutJson: string;
	applied: boolean;
	reason?: string;
}

/** Whether Rust is the authority here (not in tests or the browser demo). */
export function isRustLayoutAuthority(): boolean {
	return import.meta.env.MODE !== "test" && !isDemoMode();
}

/** `ipc.ts`, loaded on first use (see `statusSync.ts` for the cycle). */
function ipc(): Promise<typeof import("./ipc")> {
	return import("./ipc");
}

type LayoutHandler = (tabId: string, layoutJson: string) => void;

interface Job {
	tabId: string;
	ops: LayoutOp[];
	done: () => void;
}

let handler: LayoutHandler | null = null;
/** What Rust has for each Tab, as far as this Window knows. */
const base = new Map<string, string>();
const versions = new Map<string, number>();
const pending = new Map<string, number>();
let queue: Job[] = [];
let flushing = false;

/** Whether `tabId` has edits on their way to Rust. */
export function hasPendingLayoutOps(tabId: string): boolean {
	return (pending.get(tabId) ?? 0) > 0;
}

/** Test-only: forget everything. */
export function __resetLayoutSyncForTests(): void {
	base.clear();
	versions.clear();
	pending.clear();
	queue = [];
	flushing = false;
}

/** Take Rust's layout for a Tab: into `base` and, if it differs, the store. */
function adopt(tabId: string, layoutJson: string, why: string): void {
	const mine = base.get(tabId);
	base.set(tabId, layoutJson);
	const same =
		mine !== undefined &&
		sameLayout(parseTabLayout(mine), parseTabLayout(layoutJson));
	if (same) return;
	if (why === "correction") {
		console.warn("[layout] Rust corrected the Window's layout", { tabId });
	}
	handler?.(tabId, layoutJson);
}

function settle(state: LayoutState): void {
	const known = versions.get(state.tabId) ?? 0;
	if (state.version < known) return;
	versions.set(state.tabId, state.version);
	if (!state.applied) {
		console.warn("[layout] Rust did not apply the edit", state.reason);
	}
	// Still more on the way: their answer will carry this one's effect.
	if (hasPendingLayoutOps(state.tabId)) return;
	adopt(state.tabId, state.layoutJson, "correction");
}

/** Another Window changed a Tab's layout (`layout-changed`). */
export function receiveLayoutChanged(s: LayoutState): void {
	if (s.version <= (versions.get(s.tabId) ?? 0)) return;
	// Our own answer is coming and will carry this edit too.
	if (hasPendingLayoutOps(s.tabId)) return;
	versions.set(s.tabId, s.version);
	adopt(s.tabId, s.layoutJson, "broadcast");
}

/** The store registers how to take a layout from Rust (once, at load). */
export function onLayoutFromRust(fn: LayoutHandler): void {
	handler = fn;
	if (!isRustLayoutAuthority()) return;
	ipc()
		.then(({ listenToThisWindow }) =>
			listenToThisWindow<LayoutState>("layout-changed", (event) =>
				receiveLayoutChanged(event.payload),
			),
		)
		.catch((e) => console.warn("[layout] cannot hear other Windows", e));
}

/** A Tab is gone: forget what Rust had for it. */
export function forgetLayout(tabId: string): void {
	base.delete(tabId);
	versions.delete(tabId);
}

/**
 * Send a Tab's new layout to Rust as ops. Resolves once Rust has answered
 * (or failed; a failure is logged, and the next edit is sent whole).
 */
export function commitLayout(tabId: string, layoutJson: string): Promise<void> {
	const before = base.get(tabId);
	const next = parseTabLayout(layoutJson);
	if (!next) return Promise.resolve();
	const prev = before === undefined ? null : parseTabLayout(before);
	const ops: LayoutOp[] = prev
		? diffLayout(prev, next)
		: [{ op: "set", layout: next }];
	base.set(tabId, layoutJson);
	if (ops.length === 0) return Promise.resolve();
	pending.set(tabId, (pending.get(tabId) ?? 0) + 1);
	return new Promise((done) => {
		queue.push({ tabId, ops, done });
		if (!flushing) void flush();
	});
}

async function flush(): Promise<void> {
	flushing = true;
	try {
		while (queue.length > 0) {
			const job = queue.shift() as Job;
			let state: LayoutState | null = null;
			try {
				state = await (await ipc()).layoutApi.apply(job.tabId, job.ops);
			} catch (e) {
				console.warn("[layout] Rust did not take the edit", e);
				base.delete(job.tabId);
			}
			const left = (pending.get(job.tabId) ?? 1) - 1;
			if (left > 0) pending.set(job.tabId, left);
			else pending.delete(job.tabId);
			if (state) settle(state);
			job.done();
		}
	} finally {
		flushing = false;
	}
}
