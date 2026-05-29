/**
 * Pure formatting + threshold helpers for the status-bar resource readout.
 * Kept free of React/IPC so they can be unit-tested in isolation (see the
 * project convention in CLAUDE.md → Testing).
 *
 * The readout is system-wide, not Abundio-specific (see ADR-0011).
 */

// CPU is system-wide total load, 0–100%. Only CPU is threshold-coloured: it
// genuinely returns to a calm baseline, so amber/red carry signal. Memory is
// deliberately NOT coloured — macOS keeps RAM ~75% used at rest, so any
// threshold would be permanently tripped and convey nothing.
const CPU_WARN = 85; // amber at/above this
const CPU_HIGH = 95; // red at/above this

/** Integer-percent string, e.g. `23%`. Shared by CPU and the RAM percentage. */
export function formatPercent(pct: number): string {
	if (!Number.isFinite(pct) || pct <= 0) return "0%";
	return `${Math.round(pct)}%`;
}

/** Used/total ratio as an integer percent. Returns 0 when total is unknown. */
export function memoryPercent(usedBytes: number, totalBytes: number): number {
	if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes)) return 0;
	if (totalBytes <= 0) return 0;
	return (usedBytes / totalBytes) * 100;
}

/** Compact memory string: integer MB below 1 GB, else 1-dp GB. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
	const mb = bytes / 1024 ** 2;
	if (mb < 1024) return `${Math.round(mb)} MB`;
	return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * CPU threshold colour as a theme CSS variable: secondary grey when calm, amber
 * when elevated, red when high. Memory has no equivalent (always neutral).
 */
export function cpuColor(pct: number): string {
	if (Number.isFinite(pct) && pct >= CPU_HIGH) return "var(--error)";
	if (Number.isFinite(pct) && pct >= CPU_WARN) return "var(--warning)";
	return "var(--fg-secondary)";
}

/** Precise tooltip text for the CPU metric. */
export function cpuTooltip(pct: number): string {
	const v = Number.isFinite(pct) && pct > 0 ? pct : 0;
	return `CPU ${v.toFixed(1)}% — system-wide (all processes)`;
}

/** Precise tooltip text for the memory metric: used / total GB and percent. */
export function memoryTooltip(usedBytes: number, totalBytes: number): string {
	const pct = Math.round(memoryPercent(usedBytes, totalBytes));
	return `Memory ${formatBytes(usedBytes)} / ${formatBytes(totalBytes)} used (${pct}%) — system-wide`;
}
