/**
 * Tiny in-memory event bus shared by `mockInvoke` and `mockListen` in demo
 * mode. It decouples "a `pty_spawn` happened" (which schedules a transcript)
 * from "a `pty-output-<ptyId>` listener subscribed" — these resolve in either
 * order inside `terminalManager`'s `Promise.all`.
 *
 * Every published payload is retained per channel and replayed to any listener
 * that subscribes later, so a transcript reaches the foreground terminal even
 * when a background tracker subscribed to the same channel first. Delivery is
 * always async (microtask) to mirror real Tauri events and avoid reentrancy
 * during `listen()`.
 */
type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const history = new Map<string, unknown[]>();

export function subscribe(event: string, listener: Listener): () => void {
	let set = listeners.get(event);
	if (!set) {
		set = new Set();
		listeners.set(event, set);
	}
	set.add(listener);

	const past = history.get(event);
	if (past) {
		for (const payload of past) {
			queueMicrotask(() => listener(payload));
		}
	}

	return () => {
		listeners.get(event)?.delete(listener);
	};
}

export function publish(event: string, payload: unknown): void {
	let hist = history.get(event);
	if (!hist) {
		hist = [];
		history.set(event, hist);
	}
	hist.push(payload);

	const set = listeners.get(event);
	if (set) {
		for (const listener of set) {
			queueMicrotask(() => listener(payload));
		}
	}
}

/** Test-only: clear all listeners and replay history. */
export function resetBus(): void {
	listeners.clear();
	history.clear();
}
