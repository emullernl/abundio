import { useEffect, useRef, useState } from "react";
import {
	getTerminal,
	getActivityByteThreshold,
	INPUT_GATE_MS,
	INACTIVITY_RESET_MS,
} from "../../lib/terminalManager";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";

const IDLE_THRESHOLD_MS = 2500;
const POLL_MS = 100;

interface DebugSnapshot {
	bytesSinceIdle: number;
	threshold: number;
	lastOutputChunkAt: number;
	lastInputAt: number;
	inGate: boolean;
	timeSinceLastChunk: number;
}

function lerp(a: string, b: string, t: number): string {
	const parse = (hex: string) => [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
	const [r1, g1, b1] = parse(a);
	const [r2, g2, b2] = parse(b);
	const r = Math.round(r1 + (r2 - r1) * t);
	const g = Math.round(g1 + (g2 - g1) * t);
	const bl = Math.round(b1 + (b2 - b1) * t);
	return `rgb(${r},${g},${bl})`;
}

function barColor(ratio: number): string {
	if (ratio < 0.5) return lerp("#22c55e", "#f59e0b", ratio * 2);
	return lerp("#f59e0b", "#ef4444", (ratio - 0.5) * 2);
}

interface Props {
	paneId: string;
}

export function DebugActivityMeter({ paneId }: Props) {
	const [snap, setSnap] = useState<DebugSnapshot | null>(null);
	const storeThreshold = useSettingsStore((s) => s.activityByteThreshold);
	const setStoreThreshold = useSettingsStore((s) => s.setActivityByteThreshold);
	const [thresholdInput, setThresholdInput] = useState(() => String(storeThreshold));
	const inputRef = useRef<HTMLInputElement>(null);

	const ptyId = usePtyActivityStore((s) => s.panePtyMap[paneId]);
	const activity = usePtyActivityStore((s) =>
		ptyId ? s.activities[ptyId] : undefined,
	);

	useEffect(() => {
		const id = setInterval(() => {
			const managed = getTerminal(paneId);
			if (!managed) return;
			const now = Date.now();
			const threshold = getActivityByteThreshold();
			setSnap({
				bytesSinceIdle: managed.bytesSinceIdle,
				threshold,
				lastOutputChunkAt: managed.lastOutputChunkAt,
				lastInputAt: managed.lastInputAt,
				inGate: now - managed.lastInputAt < INPUT_GATE_MS,
				timeSinceLastChunk: managed.lastOutputChunkAt
					? now - managed.lastOutputChunkAt
					: 0,
			});

			// Keep input in sync unless user is editing
			if (document.activeElement !== inputRef.current) {
				setThresholdInput(String(useSettingsStore.getState().activityByteThreshold));
			}
		}, POLL_MS);
		return () => clearInterval(id);
	}, [paneId]);

	const handleThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setThresholdInput(e.target.value);
		const n = Number(e.target.value);
		if (!Number.isNaN(n) && n > 0) {
			setStoreThreshold(n);
		}
	};

	if (!snap) return null;

	const state = activity?.state ?? "idle";
	const byteRatio = Math.min(1, snap.bytesSinceIdle / snap.threshold);
	const isActive = state === "active";

	// Waiting countdown: time since last output toward IDLE_THRESHOLD_MS
	let waitingRatio = 0;
	if (isActive && activity?.lastOutputAt) {
		const elapsed = Date.now() - activity.lastOutputAt;
		waitingRatio = Math.min(1, elapsed / IDLE_THRESHOLD_MS);
	}

	// Inactivity reset countdown: progress toward 3s reset
	const resetRatio = snap.lastOutputChunkAt
		? Math.min(1, snap.timeSinceLastChunk / INACTIVITY_RESET_MS)
		: 0;

	const dimmed = snap.inGate ? 0.35 : 1;

	return (
		<div
			style={{
				height: 22,
				padding: "0 8px",
				display: "flex",
				alignItems: "center",
				gap: 8,
				fontSize: 10,
				fontFamily: "var(--font-mono, monospace)",
				color: "var(--fg-secondary)",
				background: "color-mix(in srgb, var(--bg-secondary) 60%, transparent)",
				borderBottom: "1px solid var(--border)",
				opacity: dimmed,
				userSelect: "none",
				flexShrink: 0,
			}}
		>
			{/* State badge */}
			<span
				style={{
					fontWeight: 600,
					color:
						state === "active"
							? "#f59e0b"
							: state === "waiting"
								? "#8b5cf6"
								: state === "error"
									? "var(--error)"
									: "var(--fg-secondary)",
				}}
			>
				{state.toUpperCase()}
			</span>

			{/* Byte accumulation bar */}
			<div
				style={{
					flex: 1,
					height: 8,
					borderRadius: 4,
					background: "var(--bg-primary)",
					overflow: "hidden",
					position: "relative",
				}}
			>
				<div
					style={{
						width: `${byteRatio * 100}%`,
						height: "100%",
						background: barColor(byteRatio),
						borderRadius: 4,
						transition: "width 80ms linear",
					}}
				/>
			</div>

			{/* Byte count */}
			<span style={{ minWidth: 70, textAlign: "right" }}>
				{snap.bytesSinceIdle}/{snap.threshold}b
			</span>

			{/* Inactivity reset countdown (3s gap resets bytes) */}
			{snap.lastOutputChunkAt > 0 && !isActive && (
				<div
					title="Inactivity reset (3s)"
					style={{
						width: 30,
						height: 8,
						borderRadius: 4,
						background: "var(--bg-primary)",
						overflow: "hidden",
					}}
				>
					<div
						style={{
							width: `${resetRatio * 100}%`,
							height: "100%",
							background:
								resetRatio >= 1
									? "var(--fg-secondary)"
									: "color-mix(in srgb, var(--fg-secondary) 50%, transparent)",
							borderRadius: 4,
							transition: "width 80ms linear",
						}}
					/>
				</div>
			)}

			{/* Gate indicator */}
			{snap.inGate && (
				<span style={{ color: "#f59e0b", fontWeight: 600 }}>GATE</span>
			)}

			{/* Waiting countdown bar (only when active) */}
			{isActive && (
				<div
					title="Waiting transition (2.5s)"
					style={{
						width: 40,
						height: 8,
						borderRadius: 4,
						background: "var(--bg-primary)",
						overflow: "hidden",
					}}
				>
					<div
						style={{
							width: `${waitingRatio * 100}%`,
							height: "100%",
							background: "#8b5cf6",
							borderRadius: 4,
							transition: "width 80ms linear",
						}}
					/>
				</div>
			)}

			{/* Threshold input */}
			<input
				ref={inputRef}
				type="number"
				value={thresholdInput}
				onChange={handleThresholdChange}
				style={{
					width: 52,
					height: 16,
					fontSize: 10,
					fontFamily: "inherit",
					background: "var(--bg-primary)",
					color: "var(--fg-primary)",
					border: "1px solid var(--border)",
					borderRadius: 3,
					padding: "0 4px",
					textAlign: "right",
					outline: "none",
				}}
				title="Byte threshold (global)"
				min={1}
			/>
		</div>
	);
}
