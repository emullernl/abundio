import { pty } from "./ipc";

type SnapshotFn = () => string | undefined;

const registry = new Map<string, SnapshotFn>();

export function registerSnapshot(paneId: string, fn: SnapshotFn) {
	registry.set(paneId, fn);
}

export function unregisterSnapshot(paneId: string) {
	registry.delete(paneId);
}

/** Save all registered terminal snapshots. Returns when all writes complete. */
export async function saveAllSnapshots(): Promise<void> {
	const writes: Promise<void>[] = [];
	for (const [paneId, fn] of registry) {
		try {
			const data = fn();
			if (data) {
				writes.push(pty.writeSnapshot(paneId, data));
			}
		} catch {
			// Terminal may be in an intermediate state
		}
	}
	await Promise.allSettled(writes);
}
