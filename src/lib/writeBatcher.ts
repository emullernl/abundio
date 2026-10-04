/** Batches PTY output chunks into one `term.write()` per animation frame.
 *
 *  An animation frame alone is not enough: WKWebView stops running
 *  `requestAnimationFrame` callbacks while a window is minimised, hidden or
 *  covered, but Tauri events keep arriving. With rAF as the only drain, every
 *  live pane queued its output for as long as the window stayed out of sight —
 *  hundreds of MB per busy agent pane over a night — and then copied the whole
 *  queue into one array on the way back. So a timer races the frame (timers
 *  keep running, if throttled, in a hidden page), and a queue past
 *  `maxBytes` is written immediately. xterm does its own parse batching, so
 *  writing without waiting for a paint is safe. */

export interface WriteScheduler {
	requestFrame: (cb: () => void) => number;
	cancelFrame: (id: number) => void;
	setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer: (id: ReturnType<typeof setTimeout>) => void;
}

export interface WriteBatcher {
	push(chunk: Uint8Array): void;
	/** Write everything queued now and cancel the pending drain. */
	flush(): void;
	isEmpty(): boolean;
}

/** How long a batch may wait for a frame before a timer writes it. */
export const WRITE_FALLBACK_MS = 100;
/** Queue size that is written at once rather than waiting for a frame. */
export const WRITE_MAX_QUEUED_BYTES = 1024 * 1024;

const browserScheduler: WriteScheduler = {
	requestFrame: (cb) => requestAnimationFrame(cb),
	cancelFrame: (id) => cancelAnimationFrame(id),
	setTimer: (cb, ms) => setTimeout(cb, ms),
	clearTimer: (id) => clearTimeout(id),
};

export function createWriteBatcher(
	write: (data: Uint8Array) => void,
	scheduler: WriteScheduler = browserScheduler,
	{
		fallbackMs = WRITE_FALLBACK_MS,
		maxBytes = WRITE_MAX_QUEUED_BYTES,
	}: { fallbackMs?: number; maxBytes?: number } = {},
): WriteBatcher {
	let chunks: Uint8Array[] = [];
	let bytes = 0;
	let frameId: number | null = null;
	let timerId: ReturnType<typeof setTimeout> | null = null;

	function cancelDrain(): void {
		if (frameId !== null) scheduler.cancelFrame(frameId);
		if (timerId !== null) scheduler.clearTimer(timerId);
		frameId = null;
		timerId = null;
	}

	function flush(): void {
		cancelDrain();
		if (chunks.length === 0) return;
		const queued = chunks;
		const total = bytes;
		chunks = [];
		bytes = 0;
		if (queued.length === 1) {
			write(queued[0]);
			return;
		}
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const c of queued) {
			merged.set(c, offset);
			offset += c.length;
		}
		write(merged);
	}

	return {
		push(chunk) {
			chunks.push(chunk);
			bytes += chunk.length;
			if (bytes >= maxBytes) {
				flush();
				return;
			}
			if (frameId === null) frameId = scheduler.requestFrame(flush);
			if (timerId === null) timerId = scheduler.setTimer(flush, fallbackMs);
		},
		flush,
		isEmpty: () => chunks.length === 0,
	};
}
