import { SectionTitle } from "./StatsActivityChart";
import { formatCount, formatDuration, type KeyAggregate } from "./statsCompute";

const MAX_ROWS = 8;

export function StatsWorkspaceBreakdown({
	workspaces,
}: {
	workspaces: KeyAggregate[];
}) {
	const rows = workspaces.slice(0, MAX_ROWS);
	const max = Math.max(1, ...rows.map((w) => w.workingMs));

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<SectionTitle>By workspace</SectionTitle>
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: 8,
					backgroundColor: "var(--bg-secondary)",
					padding: 14,
					display: "flex",
					flexDirection: "column",
					gap: 11,
				}}
			>
				{rows.length === 0 ? (
					<div
						style={{
							color: "var(--fg-secondary)",
							fontSize: 12,
							padding: "8px 0",
						}}
					>
						No workspace activity in this range
					</div>
				) : (
					rows.map((w) => (
						<div
							key={w.key}
							style={{ display: "flex", flexDirection: "column", gap: 4 }}
						>
							<div
								style={{
									display: "flex",
									justifyContent: "space-between",
									fontSize: 12,
									gap: 8,
								}}
							>
								<span
									style={{
										color: "var(--fg-primary)",
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
									}}
									title={w.name}
								>
									{w.name || "(unknown)"}
								</span>
								<span
									style={{
										color: "var(--fg-secondary)",
										fontFamily: "var(--font-mono)",
										fontSize: 11,
										whiteSpace: "nowrap",
										fontVariantNumeric: "tabular-nums",
									}}
								>
									{formatDuration(w.workingMs)} · {formatCount(w.turnCount)}t
								</span>
							</div>
							<div
								style={{
									height: 6,
									borderRadius: 3,
									backgroundColor: "var(--bg-tertiary)",
									overflow: "hidden",
								}}
							>
								<div
									className="stats-bar-grow-x"
									style={{
										height: "100%",
										width: `${(w.workingMs / max) * 100}%`,
										minWidth: w.workingMs > 0 ? 3 : 0,
										borderRadius: 3,
										backgroundColor: "var(--accent)",
									}}
								/>
							</div>
						</div>
					))
				)}
			</div>
		</section>
	);
}
