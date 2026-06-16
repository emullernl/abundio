import { useState } from "react";
import type { AgentTurnBucket, TelemetryBucket } from "../../lib/ipc";
import { formatCount, formatDuration } from "./statsCompute";
import { formatBucketLabel } from "./statsRange";

type Metric = "working" | "turns" | "lines";

const METRICS: { id: Metric; label: string }[] = [
	{ id: "working", label: "Working time" },
	{ id: "turns", label: "Turns" },
	{ id: "lines", label: "Lines" },
];

function metricValue(b: AgentTurnBucket, m: Metric): number {
	if (m === "working") return b.totalWorkingMs;
	if (m === "turns") return b.turnCount;
	return b.totalLinesAdded + b.totalLinesDeleted;
}

function formatMetric(v: number, m: Metric): string {
	return m === "working" ? formatDuration(v) : formatCount(v);
}

const CHART_HEIGHT = 150;

export function StatsActivityChart({
	buckets,
	granularity,
}: {
	buckets: AgentTurnBucket[];
	granularity: TelemetryBucket;
}) {
	const [metric, setMetric] = useState<Metric>("working");
	const max = Math.max(1, ...buckets.map((b) => metricValue(b, metric)));

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<header
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<SectionTitle>Activity</SectionTitle>
				<div style={{ display: "flex", gap: 2 }}>
					{METRICS.map((m) => {
						const active = m.id === metric;
						return (
							<button
								key={m.id}
								type="button"
								onClick={() => setMetric(m.id)}
								style={{
									fontSize: 10.5,
									padding: "3px 9px",
									borderRadius: 5,
									border: "1px solid",
									borderColor: active ? "var(--accent)" : "transparent",
									color: active ? "var(--accent)" : "var(--fg-secondary)",
									backgroundColor: active
										? "var(--bg-tertiary)"
										: "transparent",
									cursor: "pointer",
								}}
							>
								{m.label}
							</button>
						);
					})}
				</div>
			</header>

			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: 8,
					backgroundColor: "var(--bg-secondary)",
					padding: "14px 14px 8px",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "flex-end",
						gap: buckets.length > 40 ? 1 : 3,
						height: CHART_HEIGHT,
					}}
				>
					{buckets.length === 0 && (
						<div
							style={{
								margin: "auto",
								color: "var(--fg-secondary)",
								fontSize: 12,
							}}
						>
							No activity in this range
						</div>
					)}
					{buckets.map((b) => {
						const v = metricValue(b, metric);
						const pct = (v / max) * 100;
						return (
							<div
								key={b.bucket}
								title={`${formatBucketLabel(b.bucket, granularity)} · ${formatMetric(v, metric)} · ${b.turnCount} turn${b.turnCount === 1 ? "" : "s"}`}
								style={{
									flex: 1,
									minWidth: 0,
									height: "100%",
									display: "flex",
									alignItems: "flex-end",
								}}
							>
								<div
									className="stats-bar-grow"
									style={{
										width: "100%",
										height: `${v > 0 ? Math.max(pct, 2) : 0}%`,
										minHeight: v > 0 ? 2 : 0,
										borderRadius: "2px 2px 0 0",
										background:
											"linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 55%, transparent))",
									}}
								/>
							</div>
						);
					})}
				</div>
				{buckets.length > 0 && (
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginTop: 6,
							fontSize: 9.5,
							color: "var(--fg-secondary)",
							fontVariantNumeric: "tabular-nums",
						}}
					>
						<span>{formatBucketLabel(buckets[0].bucket, granularity)}</span>
						<span>
							{formatBucketLabel(
								buckets[buckets.length - 1].bucket,
								granularity,
							)}
						</span>
					</div>
				)}
			</div>
		</section>
	);
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
	return (
		<span
			style={{
				fontSize: 9,
				letterSpacing: "0.13em",
				textTransform: "uppercase",
				color: "var(--fg-secondary)",
				fontWeight: 500,
			}}
		>
			{children}
		</span>
	);
}
