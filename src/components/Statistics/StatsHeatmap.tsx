import type { AgentTurnRecord } from "../../lib/ipc";
import { SectionTitle } from "./StatsActivityChart";
import {
	busiestDay,
	computeHeatmap,
	computeStreaks,
	formatDuration,
} from "./statsCompute";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function StatsHeatmap({
	turns,
	now,
	longestTurnMs,
}: {
	turns: AgentTurnRecord[];
	now: number;
	longestTurnMs: number;
}) {
	const heat = computeHeatmap(turns);
	const streaks = computeStreaks(turns, now);
	const busiest = busiestDay(turns);

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<SectionTitle>When you run agents</SectionTitle>
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: 8,
					backgroundColor: "var(--bg-secondary)",
					padding: 14,
					display: "flex",
					flexDirection: "column",
					gap: 14,
				}}
			>
				{/* Records strip */}
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
						gap: 10,
					}}
				>
					<Record label="Current streak" value={`${streaks.current}d`} />
					<Record label="Longest streak" value={`${streaks.longest}d`} />
					<Record
						label="Busiest day"
						value={busiest ? `${busiest.count}` : "—"}
						sub={busiest?.label}
					/>
					<Record label="Longest turn" value={formatDuration(longestTurnMs)} />
				</div>

				{/* Heatmap grid */}
				<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
					{heat.cells.map((row, wd) => (
						<div
							key={WEEKDAYS[wd]}
							style={{ display: "flex", alignItems: "center", gap: 6 }}
						>
							<span
								style={{
									width: 26,
									fontSize: 9,
									color: "var(--fg-secondary)",
									flexShrink: 0,
								}}
							>
								{WEEKDAYS[wd]}
							</span>
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(24, 1fr)",
									gap: 2,
									flex: 1,
								}}
							>
								{row.map((count, hour) => {
									const ratio = heat.max ? count / heat.max : 0;
									const intensity = count === 0 ? 0 : 0.18 + 0.82 * ratio;
									return (
										<div
											// biome-ignore lint/suspicious/noArrayIndexKey: hour (0–23) is the cell's stable identity, not a transient list position
											key={`${WEEKDAYS[wd]}-h${hour}`}
											title={`${WEEKDAYS[wd]} ${String(hour).padStart(2, "0")}:00 · ${count} turn${count === 1 ? "" : "s"}`}
											style={{
												aspectRatio: "1",
												borderRadius: 2,
												backgroundColor:
													count === 0
														? "var(--bg-tertiary)"
														: `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, var(--bg-tertiary))`,
											}}
										/>
									);
								})}
							</div>
						</div>
					))}
					{/* Hour axis */}
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							marginLeft: 32,
							marginTop: 2,
							fontSize: 9,
							color: "var(--fg-secondary)",
							fontVariantNumeric: "tabular-nums",
						}}
					>
						<span>00</span>
						<span>06</span>
						<span>12</span>
						<span>18</span>
						<span>23</span>
					</div>
				</div>
			</div>
		</section>
	);
}

function Record({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
			<span
				style={{
					fontSize: 8,
					letterSpacing: "0.12em",
					textTransform: "uppercase",
					color: "var(--fg-secondary)",
				}}
			>
				{label}
			</span>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 16,
					fontWeight: 600,
					color: "var(--fg-primary)",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{value}
			</span>
			{sub && (
				<span style={{ fontSize: 10, color: "var(--fg-secondary)" }}>
					{sub}
				</span>
			)}
		</div>
	);
}
