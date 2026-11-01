/**
 * Switch timer: measures how long a Workspace or tab switch takes, from the
 * store update to the first painted frame and on until the main thread is
 * free again.
 *
 * Phases of one switch:
 *   start  → set     the store update and every synchronous subscriber
 *   set    → commit  React rendering and committing the new tree
 *   commit → paint   style, layout and paint of the first frame
 *   paint  → idle    work that keeps the main thread busy afterwards
 *                    (effects, IPC replies, late re-renders). "Idle" is the
 *                    end of the last slow frame (> SLOW_FRAME_MS) seen within
 *                    WATCH_MS of the paint.
 *
 * Off unless enabled: on in dev builds and the demo, or anywhere with
 * `localStorage["abundio-switch-timer"] = "1"`. Results go to the console, to
 * a small on-screen readout, and to `window.__abundioSwitchTimings` so a test
 * harness can read them. The readout is plain DOM, not React, so drawing it
 * does not add to the thing it measures.
 */

export type SwitchKind = "workspace" | "tab";

export interface SwitchTiming {
	kind: SwitchKind;
	label: string;
	/** start → set, ms */
	set: number;
	/** set → commit, ms */
	render: number;
	/** commit → first painted frame, ms */
	paint: number;
	/** start → first painted frame, ms: what the user sees as "the switch" */
	visible: number;
	/** start → end of the last slow frame, ms: when input feels free again */
	idle: number;
	/** the longest single frame in the watch window, ms */
	longestFrame: number;
}

const SLOW_FRAME_MS = 50;
const WATCH_MS = 1500;
const MAX_KEPT = 50;

interface Pending {
	kind: SwitchKind;
	label: string;
	start: number;
	set?: number;
	commit?: number;
}

let pending: Pending | null = null;

function readFlag(): boolean {
	try {
		const v = localStorage.getItem("abundio-switch-timer");
		if (v === "1") return true;
		if (v === "0") return false;
	} catch {
		// Storage may be unavailable; fall through to the build default.
	}
	return Boolean(import.meta.env.DEV || import.meta.env.VITE_ABUNDIO_DEMO);
}

let enabled: boolean | null = null;
export function switchTimerEnabled(): boolean {
	if (enabled === null) enabled = readFlag();
	return enabled;
}

/** Call just before the store update that starts a switch. */
export function beginSwitch(kind: SwitchKind, label: string): void {
	if (!switchTimerEnabled()) return;
	pending = { kind, label, start: performance.now() };
}

/** Call right after that store update returns. */
export function markSwitchSet(): void {
	if (pending && pending.set === undefined) pending.set = performance.now();
}

/** Call from a layout effect that runs when the switch commits. Starts
 *  watching frames; the result is reported once the main thread settles. */
export function markSwitchCommit(): void {
	const p = pending;
	if (!p || p.commit !== undefined) return;
	p.commit = performance.now();
	pending = null;
	const set = p.set ?? p.commit;

	let paint: number | null = null;
	let last = 0;
	let idle = 0;
	let longest = 0;
	const tick = () => {
		// performance.now() rather than the rAF timestamp: the timestamp is the
		// frame's start, which can precede the work that delayed it.
		const t = performance.now();
		if (paint === null) {
			paint = t;
			last = t;
			idle = t;
			requestAnimationFrame(tick);
			return;
		}
		const gap = t - last;
		if (gap > longest) longest = gap;
		if (gap > SLOW_FRAME_MS) idle = t;
		last = t;
		if (t - paint < WATCH_MS) {
			requestAnimationFrame(tick);
			return;
		}
		report({
			kind: p.kind,
			label: p.label,
			set: set - p.start,
			render: (p.commit as number) - set,
			paint: paint - (p.commit as number),
			visible: paint - p.start,
			idle: idle - p.start,
			longestFrame: longest,
		});
	};
	requestAnimationFrame(tick);
}

const round = (n: number) => Math.round(n);

function report(t: SwitchTiming): void {
	const w = window as unknown as { __abundioSwitchTimings?: SwitchTiming[] };
	const list = w.__abundioSwitchTimings ?? [];
	list.push(t);
	if (list.length > MAX_KEPT) list.shift();
	w.__abundioSwitchTimings = list;

	console.info(
		`[switch-timer] ${t.kind} → ${t.label}: visible ${round(t.visible)}ms ` +
			`(set ${round(t.set)}, render ${round(t.render)}, paint ${round(t.paint)}), ` +
			`idle ${round(t.idle)}ms, longest frame ${round(t.longestFrame)}ms`,
	);
	showReadout(t);
}

let readout: HTMLDivElement | null = null;
function showReadout(t: SwitchTiming): void {
	try {
		if (!readout) {
			readout = document.createElement("div");
			readout.setAttribute("data-switch-timer", "");
			Object.assign(readout.style, {
				position: "fixed",
				right: "8px",
				bottom: "30px",
				zIndex: "99999",
				font: "11px/1.4 ui-monospace, monospace",
				padding: "6px 8px",
				borderRadius: "6px",
				background: "rgba(0,0,0,0.75)",
				color: "#e5e5e5",
				pointerEvents: "none",
				whiteSpace: "pre",
			});
			document.body.appendChild(readout);
		}
		readout.textContent =
			`${t.kind} → ${t.label}\n` +
			`visible ${round(t.visible)} ms  (set ${round(t.set)} · render ${round(t.render)} · paint ${round(t.paint)})\n` +
			`idle    ${round(t.idle)} ms  (longest frame ${round(t.longestFrame)})`;
	} catch {
		// Display only.
	}
}
