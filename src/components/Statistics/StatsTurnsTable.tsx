import type { AgentTurnRecord } from "../../lib/ipc";
import { SectionTitle } from "./StatsActivityChart";
import { agentLabel, formatDuration } from "./statsCompute";

const MAX_ROWS = 60;
const GRID = "1.1fr 1.5fr 1fr 0.7fr 0.7fr 1.1fr";

function startedLabel(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function StatsTurnsTable({ turns }: { turns: AgentTurnRecord[] }) {
	const rows = turns.slice(0, MAX_ROWS);

	return (
		<section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<SectionTitle>Recent turns</SectionTitle>
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: 8,
					backgroundColor: "var(--bg-secondary)",
					overflow: "hidden",
				}}
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: GRID,
						gap: 10,
						padding: "9px 14px",
						fontSize: 8.5,
						letterSpacing: "0.1em",
						textTransform: "uppercase",
						color: "var(--fg-secondary)",
						borderBottom: "1px solid var(--border)",
					}}
				>
					<span>Agent</span>
					<span>Workspace</span>
					<span>Started</span>
					<span>Wall</span>
					<span>Working</span>
					<span style={{ textAlign: "right" }}>Lines</span>
				</div>
				{rows.length === 0 ? (
					<div
						style={{
							padding: "14px",
							color: "var(--fg-secondary)",
							fontSize: 12,
						}}
					>
						No turns in this range
					</div>
				) : (
					rows.map((t) => (
						<div
							key={t.id}
							style={{
								display: "grid",
								gridTemplateColumns: GRID,
								gap: 10,
								padding: "8px 14px",
								fontSize: 11.5,
								borderTop:
									"1px solid color-mix(in srgb, var(--border) 55%, transparent)",
								fontVariantNumeric: "tabular-nums",
								alignItems: "center",
							}}
						>
							<span style={{ color: "var(--fg-primary)" }}>
								{agentLabel(t.agentId)}
							</span>
							<span
								title={t.workspacePath}
								style={{
									color: "var(--fg-secondary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{t.workspaceName || "—"}
							</span>
							<span
								style={{
									color: "var(--fg-secondary)",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{startedLabel(t.startedAt)}
							</span>
							<span
								style={{
									color: "var(--fg-secondary)",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{formatDuration(t.durationMs ?? 0)}
							</span>
							<span
								style={{
									color: "var(--fg-primary)",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{formatDuration(t.workingMs ?? 0)}
							</span>
							<span
								style={{
									textAlign: "right",
									fontFamily: "var(--font-mono)",
									fontSize: 11,
								}}
							>
								{t.linesAdded === null || t.linesDeleted === null ? (
									<span style={{ color: "var(--fg-secondary)", opacity: 0.7 }}>
										unmeasured
									</span>
								) : (
									<>
										<span style={{ color: "rgb(124 196 144)" }}>
											+{t.linesAdded}
										</span>{" "}
										<span style={{ color: "rgb(244 113 116)" }}>
											−{t.linesDeleted}
										</span>
									</>
								)}
							</span>
						</div>
					))
				)}
			</div>
		</section>
	);
}
