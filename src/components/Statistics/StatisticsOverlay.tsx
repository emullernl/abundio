import { BarChart3, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProfileStore } from "../../stores/profileStore";
import { useTelemetryStore } from "../../stores/telemetryStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { StatsActivityChart } from "./StatsActivityChart";
import { StatsAgentBreakdown } from "./StatsAgentBreakdown";
import { StatsHeatmap } from "./StatsHeatmap";
import { StatsRangeControls } from "./StatsRangeControls";
import { StatsSummaryCards } from "./StatsSummaryCards";
import { StatsTurnsTable } from "./StatsTurnsTable";
import { StatsWorkspaceBreakdown } from "./StatsWorkspaceBreakdown";
import { aggregateBy, densifyBuckets } from "./statsCompute";
import { computeRange, type StatsPeriod } from "./statsRange";

/** Animations + reduced-motion fallback, scoped to the overlay. */
const OVERLAY_STYLES = `
@keyframes stats-overlay-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes stats-reveal { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes stats-bar-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes stats-bar-grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.stats-overlay-in { animation: stats-overlay-in 180ms ease-out; }
.stats-reveal { animation: stats-reveal 280ms ease-out both; }
.stats-bar-grow { transform-origin: bottom; animation: stats-bar-grow 420ms cubic-bezier(0.2,0.7,0.3,1) both; }
.stats-bar-grow-x { transform-origin: left; animation: stats-bar-grow-x 420ms cubic-bezier(0.2,0.7,0.3,1) both; }
@media (prefers-reduced-motion: reduce) {
  .stats-overlay-in, .stats-reveal, .stats-bar-grow, .stats-bar-grow-x { animation: none; }
}
`;

export function StatisticsOverlay({ topOffset }: { topOffset: number }) {
	const open = useWindowUiStore((s) => s.statisticsOverlayOpen);
	const setOpen = useWindowUiStore((s) => s.setStatisticsOverlayOpen);
	const activeProfileId = useProfileStore((s) => s.activeProfileId);
	const profileName = useProfileStore(
		(s) => s.profiles.find((p) => p.id === s.activeProfileId)?.name,
	);

	const [period, setPeriod] = useState<StatsPeriod>("month");
	const [offset, setOffset] = useState(0);
	// Freeze "now" while the overlay is open so the range doesn't drift between
	// renders; refreshed each time it reopens.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (open) setNow(Date.now());
	}, [open]);

	// Esc closes the overlay. Capture phase so it beats xterm's own handlers.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, setOpen]);

	const range = useMemo(
		() => computeRange(period, offset, now),
		[period, offset, now],
	);

	const data = useTelemetryStore((s) => s.data);
	const loading = useTelemetryStore((s) => s.loading);
	const error = useTelemetryStore((s) => s.error);
	const load = useTelemetryStore((s) => s.load);

	useEffect(() => {
		if (!open || !activeProfileId) return;
		load(activeProfileId, range.fromMs, range.toMs, range.bucket);
	}, [open, activeProfileId, range.fromMs, range.toMs, range.bucket, load]);

	const timeSeries = useMemo(
		() =>
			data
				? densifyBuckets(
						data.timeSeries,
						range.fromMs,
						range.toMs,
						range.bucket,
					)
				: [],
		[data, range.fromMs, range.toMs, range.bucket],
	);
	const byAgent = useMemo(
		() => (data ? aggregateBy(data.byAgent, "agent") : []),
		[data],
	);
	const byWorkspace = useMemo(
		() => (data ? aggregateBy(data.byWorkspace, "workspace") : []),
		[data],
	);
	const topAgent = byAgent[0] ?? null;
	const topAgentShare = useMemo(() => {
		const total = byAgent.reduce((s, a) => s + a.workingMs, 0);
		return topAgent && total ? topAgent.workingMs / total : 0;
	}, [byAgent, topAgent]);

	if (!open) return null;

	const changePeriod = (p: StatsPeriod) => {
		setPeriod(p);
		setOffset(0);
	};

	const empty = data && data.totals.turnCount === 0 && !loading;

	return (
		<div
			className="stats-overlay-in"
			style={{
				position: "absolute",
				top: topOffset,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 30,
				display: "flex",
				flexDirection: "column",
				background: "var(--ambient-glow-top), var(--bg-primary)",
			}}
		>
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, no user data */}
			<style dangerouslySetInnerHTML={{ __html: OVERLAY_STYLES }} />

			{/* Header */}
			<header
				style={{
					display: "flex",
					alignItems: "center",
					gap: 16,
					padding: "12px 18px",
					borderBottom: "1px solid var(--border)",
					flexShrink: 0,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 9 }}>
					<BarChart3 size={16} style={{ color: "var(--accent)" }} />
					<span
						style={{
							fontSize: 14,
							fontWeight: 600,
							color: "var(--fg-primary)",
						}}
					>
						Statistics
					</span>
					{profileName && (
						<span
							style={{
								fontSize: 10.5,
								padding: "2px 8px",
								borderRadius: 4,
								backgroundColor: "var(--bg-tertiary)",
								color: "var(--fg-secondary)",
							}}
						>
							{profileName}
						</span>
					)}
				</div>

				<div style={{ marginLeft: "auto" }}>
					<StatsRangeControls
						period={period}
						onPeriodChange={changePeriod}
						offset={offset}
						onOffsetChange={setOffset}
						range={range}
					/>
				</div>

				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-label="Close statistics"
					title="Close (Esc · Cmd/Ctrl+Shift+S)"
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						width: 28,
						height: 28,
						borderRadius: 6,
						border: "1px solid var(--border)",
						backgroundColor: "transparent",
						color: "var(--fg-secondary)",
						cursor: "pointer",
					}}
				>
					<X size={16} />
				</button>
			</header>

			{/* Body */}
			<div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
				<div
					style={{
						maxWidth: 1120,
						margin: "0 auto",
						padding: "20px 18px 40px",
						display: "flex",
						flexDirection: "column",
						gap: 22,
					}}
				>
					{error ? (
						<Centered>Couldn’t load statistics: {error}</Centered>
					) : !data && loading ? (
						<Centered>Loading…</Centered>
					) : empty ? (
						<Centered>
							No agent activity in {profileName ?? "this profile"} for{" "}
							{range.label.toLowerCase()}.
							<div
								style={{
									fontSize: 12,
									marginTop: 8,
									color: "var(--fg-secondary)",
								}}
							>
								Run an agent in a workspace and its turns will appear here.
							</div>
						</Centered>
					) : data ? (
						<>
							<StatsSummaryCards
								totals={data.totals}
								topAgentId={topAgent?.key ?? null}
								topAgentShare={topAgentShare}
							/>
							<StatsActivityChart
								buckets={timeSeries}
								granularity={range.bucket}
							/>
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
									gap: 22,
								}}
							>
								<StatsAgentBreakdown agents={byAgent} />
								<StatsWorkspaceBreakdown workspaces={byWorkspace} />
							</div>
							<StatsHeatmap
								turns={data.turns}
								now={now}
								longestTurnMs={data.totals.longestTurnMs}
								rangeLabel={range.label}
							/>
							<StatsTurnsTable
								turns={data.turns}
								profileName={profileName}
								rangeLabel={range.label}
							/>
							<Disclaimer />
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

function Disclaimer() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "flex-start",
				gap: 8,
				padding: "11px 13px",
				borderRadius: 8,
				border: "1px solid var(--border)",
				backgroundColor: "var(--bg-secondary)",
				color: "var(--fg-secondary)",
				fontSize: 11.5,
				lineHeight: 1.5,
			}}
		>
			<Info size={14} style={{ flexShrink: 0, marginTop: 1, opacity: 0.7 }} />
			<span>
				These figures are estimates, not exact measurements. Abundio observes
				agents from the outside, so timings are approximate and some activity —
				like lines changed in folders that aren’t git repositories — can’t be
				counted. Treat the numbers as a rough guide to trends, not precise
				totals.
			</span>
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				textAlign: "center",
				minHeight: 280,
				color: "var(--fg-primary)",
				fontSize: 14,
			}}
		>
			{children}
		</div>
	);
}
