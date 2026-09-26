import { Cpu, MemoryStick, User } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useAppMetrics } from "../hooks/useAppMetrics";
import {
	type BranchLabel,
	branchLabel,
	pickBranchSource,
} from "../lib/currentBranchLabel";
import {
	cpuColor,
	cpuTooltip,
	formatPercent,
	memoryPercent,
	memoryTooltip,
} from "../lib/metricsFormat";
import { containsPane, parseTabLayout } from "../lib/paneTree";
import { shortenPath } from "../lib/shortenPath";
import { useProfileStore } from "../stores/profileStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Folder, GitBranch, Grid, Terminal } from "./Icons";
import { InjectedBundlePill } from "./WorkspaceEnv/InjectedBundlePill";

function Separator() {
	return (
		<span
			style={{
				color: "var(--border)",
				fontSize: 10,
				userSelect: "none",
				flexShrink: 0,
			}}
		>
			|
		</span>
	);
}

/**
 * Smallest width a truncating left-cluster segment may shrink to: the 12px
 * icon, its gap, and roughly two characters plus `…`. Below this the segment
 * stops giving way and the cluster's `overflow: hidden` clips from the right.
 */
const SEGMENT_FLOOR = 32;

/**
 * The `min-width` for a segment showing `label`. A label this short already
 * fits within the floor, so forcing the floor on it would only pad it with
 * blank space; `auto` keeps it at its natural width and it never shrinks.
 */
export function segmentFloor(label: string): number | "auto" {
	return label.length <= 3 ? "auto" : SEGMENT_FLOOR;
}

/**
 * `flex-shrink` weights for the left cluster. Shrink is weighted by basis
 * size, so these only approximate a strict order; spreading them by factors
 * of ten gets close enough that the folder ellipsises first, then the tab,
 * then the branch, and the Workspace name last.
 */
export const SHRINK_RANK = {
	folder: 1000,
	tab: 100,
	branch: 10,
	name: 1,
} as const;

/**
 * One text segment of the left cluster: an icon that never shrinks and a
 * label that ellipsises instead of wrapping onto a second line.
 */
function TextSegment({
	icon,
	title,
	shrink,
	className,
	color,
	label,
}: {
	icon: ReactNode;
	title: string;
	shrink: number;
	className?: string;
	color?: string;
	label: string;
}) {
	return (
		<span
			className={`flex items-center gap-1.5 whitespace-nowrap${className ? ` ${className}` : ""}`}
			style={{ minWidth: segmentFloor(label), flexShrink: shrink, color }}
			title={title}
		>
			{icon}
			<span className="truncate">{label}</span>
		</span>
	);
}

/**
 * A single live metric: a neutral icon plus a monospace, tabular-figure value
 * whose color crosses grey → amber → red by threshold. `tabular-nums` + a
 * fixed `min-width` keep the bar from shifting as digits change — the key
 * polish detail for a value that updates a few times a second.
 */
function StatusMetric({
	icon,
	value,
	color,
	title,
	minWidth,
}: {
	icon: ReactNode;
	value: string;
	color: string;
	title: string;
	minWidth: number;
}) {
	return (
		<span className="flex items-center gap-1.5" title={title}>
			{icon}
			<span
				style={{
					color,
					fontFamily: "var(--font-mono)",
					fontVariantNumeric: "tabular-nums",
					minWidth,
					textAlign: "right",
					transition: "color var(--transition-fast)",
				}}
			>
				{value}
			</span>
		</span>
	);
}

/**
 * The Active workspace's current branch — read-only, like the rest of the bar.
 *
 * Font, size and colour are all inherited from the bar so the segment sits in
 * the same voice as the folder and tab beside it; the only differentiation is
 * the dimmed `feature/` style prefix, which lets the meaningful leaf win the
 * eye on a long name.
 */
function BranchSegment({ label }: { label: BranchLabel }) {
	return (
		<span
			className="flex items-center gap-1.5 whitespace-nowrap"
			style={{
				minWidth: segmentFloor(
					label.kind === "detached" ? "detached" : label.full,
				),
				flexShrink: SHRINK_RANK.branch,
			}}
			title={label.kind === "detached" ? "Detached HEAD" : label.full}
		>
			<GitBranch size={12} className="flex-shrink-0" />
			<span className="truncate" style={{ maxWidth: 180 }}>
				{label.kind === "detached" ? (
					<span style={{ fontStyle: "italic", opacity: 0.7 }}>detached</span>
				) : (
					<>
						{label.prefix && (
							<span style={{ opacity: 0.55 }}>{label.prefix}</span>
						)}
						{label.leaf}
					</>
				)}
			</span>
		</span>
	);
}

export function StatusBar() {
	const activeWorkspace = useWorkspaceStore((s) =>
		s.activeWorkspaceId
			? (s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
			: null,
	);
	const activeTab = useWorkspaceStore((s) => {
		if (!s.activeWorkspaceId) return null;
		const tabId = s.activeTabByWorkspace[s.activeWorkspaceId];
		return (
			s.workspaces
				.find((w) => w.id === s.activeWorkspaceId)
				?.tabs.find((t) => t.id === tabId) ?? null
		);
	});

	// In the Fleet Console the bar describes the Focused tile's Workspace and
	// Tab, not the Workspace view hidden behind it (ADR-0040).
	const inFleet = useWindowUiStore(
		(s) => s.fleetConsoleOpen && !s.statisticsOverlayOpen,
	);
	const focusedTileId = useWindowUiStore((s) => s.focusedTileId);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const tileHome = useMemo(() => {
		if (!inFleet || !focusedTileId) return null;
		for (const w of workspaces) {
			for (const t of w.tabs) {
				const layout = parseTabLayout(t.layoutJson);
				if (layout && containsPane(layout, focusedTileId)) {
					return { workspace: w, tab: t };
				}
			}
		}
		return null;
	}, [inFleet, focusedTileId, workspaces]);
	const workspace = inFleet ? (tileHome?.workspace ?? null) : activeWorkspace;
	const tab = inFleet ? (tileHome?.tab ?? null) : activeTab;
	const activeProfile = useProfileStore((s) =>
		s.activeProfileId
			? (s.profiles.find((p) => p.id === s.activeProfileId) ?? null)
			: null,
	);

	// Keyed per workspace — see `pickBranchSource` for why this is the only
	// source read here.
	const gitInfo = useWorkspaceGitStore((s) =>
		workspace ? (s.byWorkspaceId[workspace.id] ?? null) : null,
	);
	const branch = branchLabel(pickBranchSource(gitInfo));

	const appMetrics = useAppMetrics();

	// Right cluster: live system-wide load + active profile. Shared by both the
	// workspace and no-workspace states, since the metrics are machine-wide
	// (not per-workspace) — see ADR-0011. CPU is threshold-coloured; memory is
	// always neutral (macOS rests near 75%, so a threshold would never rest).
	const rightCluster = (
		// Pinned: it never shrinks, so the left cluster always gives way first.
		<div className="flex items-center gap-3 flex-shrink-0 whitespace-nowrap">
			<StatusMetric
				icon={<Cpu size={12} />}
				value={appMetrics ? formatPercent(appMetrics.cpuPercent) : "—"}
				color={
					appMetrics ? cpuColor(appMetrics.cpuPercent) : "var(--fg-secondary)"
				}
				title={
					appMetrics ? cpuTooltip(appMetrics.cpuPercent) : "System CPU load"
				}
				minWidth={32}
			/>
			<StatusMetric
				icon={<MemoryStick size={12} />}
				value={
					appMetrics
						? formatPercent(
								memoryPercent(
									appMetrics.memoryUsedBytes,
									appMetrics.memoryTotalBytes,
								),
							)
						: "—"
				}
				color="var(--fg-secondary)"
				title={
					appMetrics
						? memoryTooltip(
								appMetrics.memoryUsedBytes,
								appMetrics.memoryTotalBytes,
							)
						: "System memory usage"
				}
				minWidth={32}
			/>
			{activeProfile && (
				<>
					<Separator />
					<span className="flex items-center gap-1.5">
						<User size={12} className="flex-shrink-0" />
						<span
							className="truncate"
							style={{ maxWidth: 140 }}
							title={activeProfile.name}
						>
							{activeProfile.name}
						</span>
					</span>
				</>
			)}
		</div>
	);

	return (
		<div
			className="flex items-center justify-between"
			style={{
				height: "var(--statusbar-height)",
				paddingLeft: 24,
				paddingRight: 24,
				backgroundColor: "var(--bg-secondary)",
				borderTop: "1px solid var(--border)",
				fontSize: 12,
				color: "var(--fg-secondary)",
			}}
		>
			{workspace ? (
				<>
					{/* `min-w-0` lets this cluster shrink below its content width, so it
					    gives way instead of overrunning the pinned right cluster. Its
					    segments then shrink in `SHRINK_RANK` order, each ellipsising down
					    to `SEGMENT_FLOOR`; once all are at their floor, `overflow: hidden`
					    clips from the right edge, so the tab and pill go before the
					    Workspace name. */}
					<div className="flex items-center gap-3 min-w-0 overflow-hidden">
						<TextSegment
							icon={<Grid size={12} className="flex-shrink-0" />}
							title={workspace.name}
							shrink={SHRINK_RANK.name}
							className="font-medium"
							color="var(--accent)"
							label={workspace.name}
						/>
						<Separator />
						<TextSegment
							icon={<Folder size={12} className="flex-shrink-0" />}
							title={workspace.rootFolder}
							shrink={SHRINK_RANK.folder}
							label={shortenPath(workspace.rootFolder)}
						/>
						{branch && (
							<>
								<Separator />
								<BranchSegment label={branch} />
							</>
						)}
						{tab && (
							<>
								<Separator />
								<TextSegment
									icon={<Terminal size={12} className="flex-shrink-0" />}
									title={tab.name}
									shrink={SHRINK_RANK.tab}
									label={tab.name}
								/>
							</>
						)}
						<InjectedBundlePill workspaceId={workspace.id} />
					</div>
					{rightCluster}
				</>
			) : (
				<div className="flex items-center justify-between w-full gap-3">
					<span className="truncate min-w-0">
						{inFleet ? "Fleet Console" : "No active workspace"}
					</span>
					{rightCluster}
				</div>
			)}
		</div>
	);
}
