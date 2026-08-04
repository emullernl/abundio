import { Cpu, MemoryStick, User } from "lucide-react";
import type { ReactNode } from "react";
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
import { useProfileStore } from "../stores/profileStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { Folder, GitBranch, Grid, Terminal } from "./Icons";
import { InjectedBundlePill } from "./WorkspaceEnv/InjectedBundlePill";

function shortenPath(fullPath: string): string {
	const home = "/Users/";
	if (fullPath.startsWith(home)) {
		const afterHome = fullPath.slice(home.length);
		const slashIdx = afterHome.indexOf("/");
		if (slashIdx !== -1) {
			return `~${afterHome.slice(slashIdx)}`;
		}
		return "~";
	}
	return fullPath;
}

function Separator() {
	return (
		<span style={{ color: "var(--border)", fontSize: 10, userSelect: "none" }}>
			|
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
			className="flex items-center gap-1.5 min-w-0"
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
	const workspace = useWorkspaceStore((s) =>
		s.activeWorkspaceId
			? (s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
			: null,
	);
	const tab = useWorkspaceStore((s) => {
		if (!s.activeWorkspaceId) return null;
		const tabId = s.activeTabByWorkspace[s.activeWorkspaceId];
		return (
			s.workspaces
				.find((w) => w.id === s.activeWorkspaceId)
				?.tabs.find((t) => t.id === tabId) ?? null
		);
	});
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
		<div className="flex items-center gap-3">
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
						<User size={12} />
						{activeProfile.name}
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
					{/* `min-w-0` lets the branch segment's `truncate` actually engage: a
					    flex item won't shrink below its content's min-content width
					    without it, so the cluster would overrun the right one instead of
					    ellipsising in a narrow window. */}
					<div className="flex items-center gap-3 min-w-0 overflow-hidden">
						<span
							className="flex items-center gap-1.5 font-medium"
							style={{ color: "var(--accent)" }}
						>
							<Grid size={12} />
							{workspace.name}
						</span>
						<Separator />
						<span className="flex items-center gap-1.5">
							<Folder size={12} />
							{shortenPath(workspace.rootFolder)}
						</span>
						{branch && (
							<>
								<Separator />
								<BranchSegment label={branch} />
							</>
						)}
						{tab && (
							<>
								<Separator />
								<span className="flex items-center gap-1.5">
									<Terminal size={12} />
									{tab.name}
								</span>
							</>
						)}
						<InjectedBundlePill workspaceId={workspace.id} />
					</div>
					{rightCluster}
				</>
			) : (
				<div className="flex items-center justify-between w-full">
					<span>No active workspace</span>
					{rightCluster}
				</div>
			)}
		</div>
	);
}
