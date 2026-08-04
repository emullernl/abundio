import { useSettingsStore } from "../../stores/settingsStore";
import { SectionLabel, ToggleRow } from "./primitives";

export function GithubSection() {
	const enabled = useSettingsStore((s) => s.prPollEnabled);
	const setEnabled = useSettingsStore((s) => s.setPrPollEnabled);
	const interval = useSettingsStore((s) => s.prPollIntervalMinutes);
	const setPrInterval = useSettingsStore((s) => s.setPrPollIntervalMinutes);

	const stepBtnStyle = {
		width: 22,
		height: 22,
		color: "var(--fg-secondary)",
		backgroundColor: "var(--bg-tertiary)",
		fontSize: 14,
		lineHeight: 1,
	} as const;

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
			<div>
				<SectionLabel>Pull Requests</SectionLabel>
				<ToggleRow
					checked={enabled}
					onChange={setEnabled}
					label="Automatically check for pull requests"
					description="Polls GitHub for your review requests and open PRs — one request per cycle, shared across all windows. Checks at the interval below while Abundio is focused, and hourly in the background. When off, use the Refresh button in the Pull Requests panel to check manually."
				/>
			</div>
			<div style={{ opacity: enabled ? 1 : 0.5 }}>
				<SectionLabel>Check Interval</SectionLabel>
				<div
					className="flex items-center gap-4 rounded-lg"
					style={{
						padding: "10px 14px",
						backgroundColor: "var(--bg-primary)",
						border: "1px solid var(--border)",
					}}
				>
					<span
						className="flex-shrink-0"
						style={{ fontSize: 11, color: "var(--fg-secondary)" }}
					>
						While focused
					</span>
					<input
						type="range"
						min={1}
						max={30}
						step={1}
						value={interval}
						disabled={!enabled}
						onChange={(e) => setPrInterval(Number(e.target.value))}
						className="flex-1 accent-[var(--accent)]"
						style={{ height: 3 }}
					/>
					<div className="flex items-center gap-1 flex-shrink-0">
						<button
							type="button"
							disabled={!enabled}
							onClick={() => setPrInterval(interval - 1)}
							className="rounded flex items-center justify-center transition-colors"
							style={stepBtnStyle}
						>
							-
						</button>
						<span
							className="font-mono text-center"
							style={{ fontSize: 12, color: "var(--fg-primary)", width: 48 }}
						>
							{interval} min
						</span>
						<button
							type="button"
							disabled={!enabled}
							onClick={() => setPrInterval(interval + 1)}
							className="rounded flex items-center justify-center transition-colors"
							style={stepBtnStyle}
						>
							+
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
