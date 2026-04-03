type TargetChangeCallback = (el: HTMLDivElement | null) => void;

const targets = new Map<string, HTMLDivElement>();
const listeners = new Map<string, Set<TargetChangeCallback>>();

function notify(paneId: string, el: HTMLDivElement | null) {
	const cbs = listeners.get(paneId);
	if (cbs) {
		for (const cb of cbs) cb(el);
	}
}

export function registerTarget(paneId: string, el: HTMLDivElement): void {
	targets.set(paneId, el);
	notify(paneId, el);
}

export function unregisterTarget(paneId: string): void {
	targets.delete(paneId);
	notify(paneId, null);
}

export function getTarget(paneId: string): HTMLDivElement | null {
	return targets.get(paneId) ?? null;
}

export function onTargetChange(
	paneId: string,
	cb: TargetChangeCallback,
): () => void {
	let set = listeners.get(paneId);
	if (!set) {
		set = new Set();
		listeners.set(paneId, set);
	}
	set.add(cb);
	return () => {
		set?.delete(cb);
		if (set?.size === 0) listeners.delete(paneId);
	};
}
