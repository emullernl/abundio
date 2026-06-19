import type { ReactNode } from "react";
import type { AgentTurnTotals } from "../../lib/ipc";
import { agentLabel, formatCount, formatDuration } from "./statsCompute";

function StatCard({
	label,
	value,
	sub,
	accent,
	title,
	delay,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	accent?: boolean;
	title?: string;
	delay: number;
}) {
	return (
		<div
			className="stats-reveal"
			title={title}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: "18px 20px",
				minHeight: 104,
				borderRadius: 10,
				border: "1px solid var(--border)",
				backgroundColor: "var(--bg-secondary)",
				animationDelay: `${delay}ms`,
			}}
		>
			<span
				style={{
					fontSize: 8,
					letterSpacing: "0.13em",
					textTransform: "uppercase",
					color: "var(--fg-secondary)",
					lineHeight: 1,
				}}
			>
				{label}
			</span>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 26,
					fontWeight: 600,
					lineHeight: 1.05,
					letterSpacing: "-0.02em",
					fontVariantNumeric: "tabular-nums",
					color: accent ? "var(--accent)" : "var(--fg-primary)",
				}}
			>
				{value}
			</span>
			{sub !== undefined && (
				<span
					style={{
						fontSize: 11,
						lineHeight: 1.2,
						color: "var(--fg-secondary)",
						fontVariantNumeric: "tabular-nums",
					}}
				>
					{sub}
				</span>
			)}
		</div>
	);
}

export function StatsSummaryCards({
	totals,
	topAgentId,
	topAgentShare,
}: {
	totals: AgentTurnTotals;
	topAgentId: string | null;
	topAgentShare: number;
}) {
	const turns = totals.turnCount || 0;
	const avgMs = turns ? totals.totalDurationMs / turns : 0;
	const permPerTurn = turns ? totals.totalPermissionRequests / turns : 0;
	const errorPct = turns ? (totals.totalErrors / turns) * 100 : 0;
	const unmeasured = turns - totals.attributedTurnCount;

	return (
		<div
			style={{
				display: "grid",
				// Wide tracks so the eight cards land on a 4×2 grid at the overlay's
				// content width, reflowing to fewer columns on a narrow window.
				gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
				gap: 12,
			}}
		>
			<StatCard
				label="Working time"
				value={formatDuration(totals.totalWorkingMs)}
				sub={`of ${formatDuration(totals.totalDurationMs)} wall-clock`}
				accent
				title="Time agents spent actively working (excludes time blocked waiting on you)."
				delay={0}
			/>
			<StatCard
				label="Net lines"
				value={
					<span>
						<span style={{ color: "rgb(124 196 144)" }}>
							+{formatCount(totals.totalLinesAdded)}
						</span>{" "}
						<span style={{ color: "rgb(244 113 116)" }}>
							−{formatCount(totals.totalLinesDeleted)}
						</span>
					</span>
				}
				sub={
					unmeasured > 0
						? `${unmeasured} of ${turns} turns unmeasured`
						: "net vs base branch"
				}
				title="Net lines changed vs the base branch during agent turns. Approximate; turns where two agents ran in one workspace at once are unmeasured."
				delay={40}
			/>
			<StatCard
				label="Files touched"
				value={formatCount(totals.totalFilesChanged)}
				sub="across measured turns"
				delay={80}
			/>
			<StatCard
				label="Turns"
				value={formatCount(turns)}
				sub={`${formatCount(totals.sessionCount)} session${
					totals.sessionCount === 1 ? "" : "s"
				}`}
				delay={120}
			/>
			<StatCard
				label="Avg turn"
				value={formatDuration(avgMs)}
				sub={`longest ${formatDuration(totals.longestTurnMs)}`}
				delay={160}
			/>
			<StatCard
				label="Blocked on you"
				value={formatCount(totals.totalPermissionRequests)}
				sub={`${permPerTurn.toFixed(1)} per turn`}
				title="How often a turn paused, blocked waiting on you — usually a permission prompt, though any wait counts. Lower per-turn means more autonomy. Approximate."
				delay={200}
			/>
			<StatCard
				label="Errors"
				value={formatCount(totals.totalErrors)}
				sub={`${errorPct.toFixed(0)}% of turns`}
				delay={240}
			/>
			<StatCard
				label="Top agent"
				value={topAgentId ? agentLabel(topAgentId) : "—"}
				sub={
					topAgentId
						? `${Math.round(topAgentShare * 100)}% of working time`
						: ""
				}
				delay={320}
			/>
		</div>
	);
}
