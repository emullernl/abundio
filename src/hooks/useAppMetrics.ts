import { useEffect, useState } from "react";
import { metrics } from "../lib/ipc";
import type { AppMetrics } from "../lib/types";

/**
 * Subscribes to the `app-metrics` push (whole-tree CPU + memory) from Rust and
 * returns the latest sample, or `null` until the first one arrives (~1.5s).
 * Cleans up the listener on unmount, and guards against the listen promise
 * resolving after the component has already unmounted.
 */
export function useAppMetrics(): AppMetrics | null {
	const [data, setData] = useState<AppMetrics | null>(null);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;

		metrics.onAppMetrics(setData).then((fn) => {
			if (cancelled) fn();
			else unlisten = fn;
		});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	return data;
}
