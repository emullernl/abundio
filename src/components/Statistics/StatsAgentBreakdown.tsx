import { SectionTitle } from "./StatsActivityChart";
import {
	agentColor,
	agentLabel,
	formatCompactCount,
	formatDuration,
	type KeyAggregate,
} from "./statsCompute";

export function StatsAgentBreakdown({ agents }: { agents: KeyAggregate[] }) {
	const total = agents.reduce((s, a) => s + a.workingMs, 0);
	const useTurns = total === 0;
	const denom = useTurns ? agents.reduce((s, a) => s + a.turnCount, 0) : total;

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<SectionTitle>By agent</SectionTitle>
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
				{agents.length === 0 ? (
					<Empty />
				) : (
					<>
						{/* Proportional stacked bar */}
						<div
							style={{
								display: "flex",
								height: 10,
								borderRadius: 5,
								overflow: "hidden",
								backgroundColor: "var(--bg-tertiary)",
							}}
						>
							{agents.map((a, i) => {
								const val = useTurns ? a.turnCount : a.workingMs;
								const pct = denom ? (val / denom) * 100 : 0;
								return (
									<div
										key={a.key}
										title={`${agentLabel(a.key)} · ${pct.toFixed(0)}%`}
										style={{
											width: `${pct}%`,
											backgroundColor: agentColor(a.key, i),
										}}
									/>
								);
							})}
						</div>
						{/* Legend */}
						<div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
							{agents.map((a, i) => (
								<div
									key={a.key}
									style={{
										display: "flex",
										alignItems: "center",
										gap: 9,
										fontSize: 12,
									}}
								>
									<span
										style={{
											width: 9,
											height: 9,
											borderRadius: 2,
											backgroundColor: agentColor(a.key, i),
											flexShrink: 0,
										}}
									/>
									<span style={{ color: "var(--fg-primary)", flex: 1 }}>
										{agentLabel(a.key)}
									</span>
									<span
										style={{
											color: "var(--fg-secondary)",
											fontVariantNumeric: "tabular-nums",
											fontFamily: "var(--font-mono)",
											fontSize: 11,
										}}
									>
										{formatDuration(a.workingMs)} ·{" "}
										{formatCompactCount(a.turnCount)}t
									</span>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</section>
	);
}

function Empty() {
	return (
		<div
			style={{ color: "var(--fg-secondary)", fontSize: 12, padding: "8px 0" }}
		>
			No agent activity in this range
		</div>
	);
}
