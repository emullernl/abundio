import type { TelemetryBucket } from "../../lib/ipc";

/** The selectable spans in the Statistics overlay. "Week" and "Month" bucket by
 *  day; "Year" buckets by month; "All" buckets by year. This is how the overlay
 *  delivers per-day / per-month / per-year views. */
export type StatsPeriod = "week" | "month" | "year" | "all";

export const STATS_PERIODS: { id: StatsPeriod; label: string }[] = [
	{ id: "week", label: "Week" },
	{ id: "month", label: "Month" },
	{ id: "year", label: "Year" },
	{ id: "all", label: "All" },
];

export interface StatsRange {
	fromMs: number;
	toMs: number;
	bucket: TelemetryBucket;
	label: string;
	/** Whether the range can step forward/back (All can't). */
	steppable: boolean;
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Compute the concrete `[fromMs, toMs)` window + bucket granularity + label for
 *  a period, shifted by `offset` periods (0 = current, -1 = previous, …). All
 *  boundaries are local-time midnights so they line up with the SQL `localtime`
 *  bucketing. */
export function computeRange(
	period: StatsPeriod,
	offset: number,
	now: number,
): StatsRange {
	const d = new Date(now);

	if (period === "week") {
		// Rolling 7-day window ending today, stepped by whole weeks.
		const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
		const from = new Date(end);
		from.setDate(from.getDate() - 7 + offset * 7);
		const to = new Date(end);
		to.setDate(to.getDate() + offset * 7);
		const lastDay = new Date(to.getTime() - 1);
		const firstDay = from;
		const label = `${MONTHS[firstDay.getMonth()]} ${firstDay.getDate()} – ${MONTHS[lastDay.getMonth()]} ${lastDay.getDate()}`;
		return {
			fromMs: from.getTime(),
			toMs: to.getTime(),
			bucket: "day",
			label,
			steppable: true,
		};
	}

	if (period === "month") {
		const from = new Date(d.getFullYear(), d.getMonth() + offset, 1);
		const to = new Date(d.getFullYear(), d.getMonth() + offset + 1, 1);
		return {
			fromMs: from.getTime(),
			toMs: to.getTime(),
			bucket: "day",
			label: `${MONTHS[from.getMonth()]} ${from.getFullYear()}`,
			steppable: true,
		};
	}

	if (period === "year") {
		const from = new Date(d.getFullYear() + offset, 0, 1);
		const to = new Date(d.getFullYear() + offset + 1, 0, 1);
		return {
			fromMs: from.getTime(),
			toMs: to.getTime(),
			bucket: "month",
			label: String(from.getFullYear()),
			steppable: true,
		};
	}

	// all
	return {
		fromMs: 0,
		toMs: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
		bucket: "year",
		label: "All time",
		steppable: false,
	};
}

/** Pretty label for a bucket key returned by the backend ("2026-03-10",
 *  "2026-03", "2026"). */
export function formatBucketLabel(
	bucket: string,
	granularity: TelemetryBucket,
) {
	if (granularity === "year") return bucket;
	const parts = bucket.split("-").map(Number);
	if (granularity === "month") return `${MONTHS[parts[1] - 1]} ${parts[0]}`;
	// day
	return `${MONTHS[parts[1] - 1]} ${parts[2]}`;
}
