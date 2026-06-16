import { create } from "zustand";
import {
	type AgentTurnBucket,
	type AgentTurnRecord,
	type AgentTurnTotals,
	type TelemetryBucket,
	telemetry,
} from "../lib/ipc";

/** Statistics overlay data, scoped to one Profile and a `[fromMs, toMs)` window.
 *  All five queries are fetched together when the overlay opens, the range
 *  changes, or the active Profile switches. See ADR-0018. */
export interface TelemetryData {
	/** Date-bucketed series (groupBy "none") — drives the activity chart. */
	timeSeries: AgentTurnBucket[];
	/** Date×agent rows — summed per agent client-side for the agent breakdown. */
	byAgent: AgentTurnBucket[];
	/** Date×workspace rows — summed per workspace for the workspace breakdown. */
	byWorkspace: AgentTurnBucket[];
	/** Overall totals for the summary cards. */
	totals: AgentTurnTotals;
	/** Raw Turns — feed the hour×weekday heatmap (startedAt) and the recent-Turns
	 *  table. For very large ranges this loads every Turn in the window; v1
	 *  accepts that for a personal dataset. */
	turns: AgentTurnRecord[];
}

interface TelemetryState {
	profileId: string | null;
	fromMs: number | null;
	toMs: number | null;
	bucket: TelemetryBucket;
	loading: boolean;
	error: string | null;
	data: TelemetryData | null;

	/** Fetch every query for the given Profile + window + granularity. A newer
	 *  call supersedes an in-flight one (stale results are dropped). */
	load: (
		profileId: string,
		fromMs: number,
		toMs: number,
		bucket: TelemetryBucket,
	) => Promise<void>;
	clear: () => void;
}

/** Monotonic token so a slow earlier load() can't overwrite a newer one
 *  (e.g. the user switches range twice quickly). */
let loadToken = 0;

export const useTelemetryStore = create<TelemetryState>((set) => ({
	profileId: null,
	fromMs: null,
	toMs: null,
	bucket: "day",
	loading: false,
	error: null,
	data: null,

	load: async (profileId, fromMs, toMs, bucket) => {
		const token = ++loadToken;
		set({ profileId, fromMs, toMs, bucket, loading: true, error: null });
		try {
			const [timeSeries, byAgent, byWorkspace, totals, turns] =
				await Promise.all([
					telemetry.buckets(profileId, fromMs, toMs, bucket, "none"),
					telemetry.buckets(profileId, fromMs, toMs, bucket, "agent"),
					telemetry.buckets(profileId, fromMs, toMs, bucket, "workspace"),
					telemetry.totals(profileId, fromMs, toMs),
					telemetry.listTurns(profileId, fromMs, toMs),
				]);
			if (token !== loadToken) return; // superseded
			set({
				data: { timeSeries, byAgent, byWorkspace, totals, turns },
				loading: false,
			});
		} catch (e) {
			if (token !== loadToken) return;
			set({ error: String(e), loading: false });
		}
	},

	clear: () => set({ data: null, error: null, loading: false }),
}));
