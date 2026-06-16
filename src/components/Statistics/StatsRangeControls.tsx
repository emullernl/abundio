import { ChevronLeft, ChevronRight } from "lucide-react";
import { STATS_PERIODS, type StatsPeriod, type StatsRange } from "./statsRange";

export function StatsRangeControls({
	period,
	onPeriodChange,
	offset,
	onOffsetChange,
	range,
}: {
	period: StatsPeriod;
	onPeriodChange: (p: StatsPeriod) => void;
	offset: number;
	onOffsetChange: (o: number) => void;
	range: StatsRange;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
			{/* Period segments */}
			<div
				style={{
					display: "flex",
					gap: 2,
					padding: 2,
					borderRadius: 7,
					border: "1px solid var(--border)",
					backgroundColor: "var(--bg-secondary)",
				}}
			>
				{STATS_PERIODS.map((p) => {
					const active = p.id === period;
					return (
						<button
							key={p.id}
							type="button"
							onClick={() => onPeriodChange(p.id)}
							style={{
								fontSize: 11,
								padding: "4px 12px",
								borderRadius: 5,
								border: "none",
								cursor: "pointer",
								color: active ? "var(--bg-primary)" : "var(--fg-secondary)",
								backgroundColor: active ? "var(--accent)" : "transparent",
								fontWeight: active ? 600 : 400,
							}}
						>
							{p.label}
						</button>
					);
				})}
			</div>

			{/* Stepper */}
			{range.steppable ? (
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<StepButton
						onClick={() => onOffsetChange(offset - 1)}
						label="Previous"
					>
						<ChevronLeft size={15} />
					</StepButton>
					<span
						style={{
							minWidth: 130,
							textAlign: "center",
							fontSize: 12,
							color: "var(--fg-primary)",
							fontFamily: "var(--font-mono)",
							fontVariantNumeric: "tabular-nums",
						}}
					>
						{range.label}
					</span>
					<StepButton
						onClick={() => offset < 0 && onOffsetChange(offset + 1)}
						label="Next"
						disabled={offset >= 0}
					>
						<ChevronRight size={15} />
					</StepButton>
				</div>
			) : (
				<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
					{range.label}
				</span>
			)}
		</div>
	);
}

function StepButton({
	children,
	onClick,
	label,
	disabled,
}: {
	children: React.ReactNode;
	onClick: () => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: 26,
				height: 26,
				borderRadius: 6,
				border: "1px solid var(--border)",
				backgroundColor: "var(--bg-secondary)",
				color: "var(--fg-secondary)",
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.35 : 1,
			}}
		>
			{children}
		</button>
	);
}
