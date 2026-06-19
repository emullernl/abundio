import type {
	AgentTurnBucket,
	AgentTurnRecord,
	TelemetryBucket,
} from "../../lib/ipc";

// ── Dense time-series buckets ──

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local-time bucket key matching the backend's strftime output
 *  ("2026-03-05" / "2026-03" / "2026"). */
function bucketKeyForDate(d: Date, granularity: TelemetryBucket): string {
	const y = d.getFullYear();
	if (granularity === "year") return `${y}`;
	if (granularity === "month") return `${y}-${pad2(d.getMonth() + 1)}`;
	return `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseBucketKey(key: string, granularity: TelemetryBucket): number {
	const [y, m, d] = key.split("-").map(Number);
	if (granularity === "year") return new Date(y, 0, 1).getTime();
	if (granularity === "month") return new Date(y, m - 1, 1).getTime();
	return new Date(y, m - 1, d).getTime();
}

function emptyBucket(key: string): AgentTurnBucket {
	return {
		bucket: key,
		agentId: null,
		workspaceId: null,
		workspaceName: null,
		turnCount: 0,
		attributedTurnCount: 0,
		totalDurationMs: 0,
		totalWorkingMs: 0,
		totalWaitingMs: 0,
		totalLinesAdded: 0,
		totalLinesDeleted: 0,
		totalFilesChanged: 0,
		totalPermissionRequests: 0,
		totalErrors: 0,
	};
}

/** Expand the sparse buckets the backend returns (only slots that had Turns)
 *  into a dense, gap-free series across `[fromMs, toMs)` so the activity chart
 *  reads as a real timeline — empty days/months render as zero-height bars
 *  rather than collapsing to a single full-width block. The window is clamped
 *  to the earliest data point so an "All time" range doesn't enumerate decades
 *  of empty slots. */
export function densifyBuckets(
	buckets: AgentTurnBucket[],
	fromMs: number,
	toMs: number,
	granularity: TelemetryBucket,
): AgentTurnBucket[] {
	const byKey = new Map(buckets.map((b) => [b.bucket, b]));
	// Normal windows (week/month/year) start at fromMs so leading empty slots
	// render. Only the open-ended "All time" range (fromMs = epoch 0) clamps to
	// the earliest data point, so it doesn't enumerate decades of empty slots.
	let startMs = fromMs;
	if (fromMs <= 0 && buckets.length > 0) {
		startMs = parseBucketKey(buckets[0].bucket, granularity);
	}

	const out: AgentTurnBucket[] = [];
	const cursor = new Date(startMs);
	// Snap the cursor to the start of its slot.
	if (granularity === "year") cursor.setMonth(0, 1);
	else if (granularity === "month") cursor.setDate(1);
	cursor.setHours(0, 0, 0, 0);

	// Hard cap so a pathological range can't build an unbounded array.
	for (let i = 0; i < 1000 && cursor.getTime() < toMs; i++) {
		const key = bucketKeyForDate(cursor, granularity);
		out.push(byKey.get(key) ?? emptyBucket(key));
		if (granularity === "year") cursor.setFullYear(cursor.getFullYear() + 1);
		else if (granularity === "month") cursor.setMonth(cursor.getMonth() + 1);
		else cursor.setDate(cursor.getDate() + 1);
	}
	return out;
}

// ── Formatting ──

/** Human duration from ms: "2h 14m", "47m", "38s", "0s". */
export function formatDuration(ms: number): string {
	if (!ms || ms < 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
	const days = Math.floor(h / 24);
	const remH = h % 24;
	return remH ? `${days}d ${remH}h` : `${days}d`;
}

/** Compact count with thousands separators. */
export function formatCount(n: number): string {
	return n.toLocaleString();
}

/** Signed line count, e.g. "+1,204" / "−318". */
export function formatSignedLines(n: number, sign: "+" | "-"): string {
	return `${sign}${n.toLocaleString()}`;
}

// ── CSV export ──

/** RFC-4180 field escaping: wrap in quotes when the value contains a comma,
 *  quote, or newline, and double any embedded quotes. Also neutralizes
 *  spreadsheet formula injection — a field starting with `=`, `+`, `-`, `@` (or
 *  a control char) is evaluated as a formula by Excel/Sheets, and workspace
 *  names/paths are user-controlled (a folder can be named e.g. `=cmd`). Such a
 *  field is prefixed with a `'` inside quotes so it renders as literal text. */
function csvField(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return "";
	const s = String(value);
	if (/^[=+\-@\t\r]/.test(s)) return `"'${s.replace(/"/g, '""')}"`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoOrBlank(ms: number | null): string {
	return ms === null ? "" : new Date(ms).toISOString();
}

const CSV_COLUMNS: {
	header: string;
	value: (t: AgentTurnRecord) => string | number | null;
}[] = [
	{ header: "id", value: (t) => t.id },
	{ header: "agent", value: (t) => agentLabel(t.agentId) },
	{ header: "agent_id", value: (t) => t.agentId },
	{ header: "workspace", value: (t) => t.workspaceName },
	{ header: "workspace_path", value: (t) => t.workspacePath },
	{ header: "started_at", value: (t) => new Date(t.startedAt).toISOString() },
	{ header: "ended_at", value: (t) => isoOrBlank(t.endedAt) },
	{ header: "duration_ms", value: (t) => t.durationMs },
	{ header: "working_ms", value: (t) => t.workingMs },
	{ header: "waiting_ms", value: (t) => t.waitingMs },
	{ header: "end_reason", value: (t) => t.endReason },
	// Counts each time a Turn entered a waiting/blocked state, not strictly
	// permission prompts (the activity-store signal can't distinguish them).
	{ header: "times_blocked", value: (t) => t.permissionRequestsCount },
	{ header: "errors", value: (t) => t.errorCount },
	{ header: "lines_added", value: (t) => t.linesAdded },
	{ header: "lines_deleted", value: (t) => t.linesDeleted },
	{ header: "files_changed", value: (t) => t.filesChanged },
];

/** Serialize raw Turn rows to RFC-4180 CSV (header + one row per Turn).
 *  Timestamps become ISO-8601; durations/counts stay raw (ms, integers) for
 *  analysis; the "unmeasured" case (null line/file counts) becomes empty
 *  cells rather than a placeholder string. */
export function turnsToCsv(turns: AgentTurnRecord[]): string {
	const lines = [CSV_COLUMNS.map((c) => c.header).join(",")];
	for (const t of turns) {
		lines.push(CSV_COLUMNS.map((c) => csvField(c.value(t))).join(","));
	}
	return lines.join("\r\n");
}

// ── Agent colours ──
// Stable categorical palette for the per-agent breakdown. Known agents get a
// fixed hue; anything else cycles a neutral palette so colours stay consistent
// within a render.

const AGENT_COLORS: Record<string, string> = {
	claude: "rgb(217 119 87)", // terracotta
	copilot: "rgb(124 196 144)", // green
	gemini: "rgb(96 165 250)", // blue
	qwen: "rgb(167 139 250)", // violet
	codex: "rgb(45 212 191)", // teal
	aider: "rgb(251 191 36)", // amber
	opencode: "rgb(244 114 182)", // pink
};

const FALLBACK_PALETTE = [
	"rgb(148 163 184)",
	"rgb(203 213 225)",
	"rgb(100 116 139)",
];

export function agentColor(agentId: string, index = 0): string {
	return (
		AGENT_COLORS[agentId] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length]
	);
}

export function agentLabel(agentId: string): string {
	const names: Record<string, string> = {
		claude: "Claude Code",
		copilot: "Copilot CLI",
		gemini: "Gemini CLI",
		qwen: "Qwen Code",
		codex: "Codex",
		aider: "Aider",
		opencode: "OpenCode",
	};
	return names[agentId] ?? agentId;
}

// ── Aggregation across date buckets ──

export interface KeyAggregate {
	key: string;
	name: string;
	turnCount: number;
	workingMs: number;
	durationMs: number;
	linesAdded: number;
	linesDeleted: number;
}

/** Collapse date×dimension buckets into per-dimension totals, sorted by working
 *  time descending. `dimension` selects which id/name the rows carry. */
export function aggregateBy(
	buckets: AgentTurnBucket[],
	dimension: "agent" | "workspace",
): KeyAggregate[] {
	const map = new Map<string, KeyAggregate>();
	for (const b of buckets) {
		const key =
			(dimension === "agent" ? b.agentId : b.workspaceId) ?? "(unknown)";
		const name =
			dimension === "agent" ? key : (b.workspaceName ?? key ?? "(unknown)");
		let agg = map.get(key);
		if (!agg) {
			agg = {
				key,
				name,
				turnCount: 0,
				workingMs: 0,
				durationMs: 0,
				linesAdded: 0,
				linesDeleted: 0,
			};
			map.set(key, agg);
		}
		agg.turnCount += b.turnCount;
		agg.workingMs += b.totalWorkingMs;
		agg.durationMs += b.totalDurationMs;
		agg.linesAdded += b.totalLinesAdded;
		agg.linesDeleted += b.totalLinesDeleted;
	}
	return [...map.values()].sort((a, b) => b.workingMs - a.workingMs);
}

// ── Streaks, heatmap & records (from raw Turns) ──

/** Local YYYY-MM-DD for a timestamp. */
function localDayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export interface Streaks {
	current: number;
	longest: number;
}

/** Current streak = consecutive local days with ≥1 Turn ending today (or
 *  yesterday — so an as-yet-inactive today doesn't reset it). Longest = the
 *  longest consecutive run anywhere in the data. */
export function computeStreaks(turns: AgentTurnRecord[], now: number): Streaks {
	if (turns.length === 0) return { current: 0, longest: 0 };
	const days = new Set(turns.map((t) => localDayKey(t.startedAt)));

	// longest run over the sorted distinct days
	const sorted = [...days]
		.map((k) => {
			const [y, m, d] = k.split("-").map(Number);
			return new Date(y, m, d).getTime();
		})
		.sort((a, b) => a - b);
	const DAY = 86_400_000;
	let longest = 1;
	let run = 1;
	for (let i = 1; i < sorted.length; i++) {
		const gap = Math.round((sorted[i] - sorted[i - 1]) / DAY);
		if (gap === 1) {
			run += 1;
			longest = Math.max(longest, run);
		} else if (gap > 1) {
			run = 1;
		}
	}

	// current streak walking back from today
	const today = new Date(now);
	const cursor = new Date(
		today.getFullYear(),
		today.getMonth(),
		today.getDate(),
	);
	let current = 0;
	if (!days.has(localDayKey(cursor.getTime()))) {
		// allow the streak to count through yesterday if today is empty
		cursor.setDate(cursor.getDate() - 1);
	}
	while (days.has(localDayKey(cursor.getTime()))) {
		current += 1;
		cursor.setDate(cursor.getDate() - 1);
	}
	return { current, longest };
}

export interface Heatmap {
	/** [weekday 0=Mon … 6=Sun][hour 0–23] → Turn count. */
	cells: number[][];
	max: number;
	total: number;
}

export function computeHeatmap(turns: AgentTurnRecord[]): Heatmap {
	const cells: number[][] = Array.from({ length: 7 }, () =>
		new Array(24).fill(0),
	);
	let max = 0;
	for (const t of turns) {
		const d = new Date(t.startedAt);
		const weekday = (d.getDay() + 6) % 7; // Mon-first
		const hour = d.getHours();
		cells[weekday][hour] += 1;
		if (cells[weekday][hour] > max) max = cells[weekday][hour];
	}
	return { cells, max, total: turns.length };
}

export interface BusiestDay {
	dayKey: string;
	label: string;
	count: number;
}

/** The local day with the most Turns. */
export function busiestDay(turns: AgentTurnRecord[]): BusiestDay | null {
	if (turns.length === 0) return null;
	const counts = new Map<string, number>();
	for (const t of turns) {
		const k = localDayKey(t.startedAt);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	let best: [string, number] | null = null;
	for (const entry of counts) {
		if (!best || entry[1] > best[1]) best = entry;
	}
	if (!best) return null;
	const [y, m, d] = best[0].split("-").map(Number);
	const label = new Date(y, m, d).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	return { dayKey: best[0], label, count: best[1] };
}
