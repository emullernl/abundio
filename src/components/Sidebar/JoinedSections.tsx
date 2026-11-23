import { Cloud, MoreHorizontal, Plus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { dividersBefore } from "../../lib/sectionDividers";
import type { WorkspaceWithTabs } from "../../lib/types";
import { type JoinedEntry, useJoinedStore } from "../../stores/joinedStore";
import { useProfileStore } from "../../stores/profileStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { OpenRemoteProfileDialog } from "../OpenRemoteProfileDialog";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";
import {
	useSectionFolded,
	WorkspaceSectionHeader,
} from "./WorkspaceSectionHeader";

/** "last seen 5 min ago", for a section whose Host is not reachable. */
export function lastSeen(ms: number | null, now = Date.now()): string {
	if (ms === null) return "never reached";
	const min = Math.round((now - ms) / 60000);
	if (min < 1) return "last seen just now";
	if (min < 60) return `last seen ${min} min ago`;
	const h = Math.round(min / 60);
	if (h < 24) return `last seen ${h} h ago`;
	return `last seen ${new Date(ms).toLocaleDateString()}`;
}

/**
 * The Workspace list's sections for **Joined profiles** (docs/plans/
 * remote-hosts.md phase 10): one per Remote profile this Window's Profile
 * shows, headed `☁ <host> · <Profile>` with its connection dot, then its
 * Workspaces, drawn by the list itself (`renderRows`). While the Host cannot
 * be reached they are greyed and do not open; "Sign in" when ssh needs the
 * user. "+ Join remote profile…" at the bottom.
 */
export function JoinedSections({
	renderRows,
	collapsed = false,
	renderCollapsed,
	ownShows = true,
}: {
	renderRows: (workspaces: WorkspaceWithTabs[], offline: boolean) => ReactNode;
	/** The sidebar is collapsed: each section's Workspaces as strips, under a
	 *  divider, with no header. */
	collapsed?: boolean;
	renderCollapsed?: (workspaces: WorkspaceWithTabs[]) => ReactNode;
	/** This Window's own section shows something above these. */
	ownShows?: boolean;
}) {
	const entries = useJoinedStore((s) => s.entries);
	const remote = useProfileStore((s) => s.remote);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const folded = useWindowUiStore((s) => s.foldedSectionKeys);
	const [joining, setJoining] = useState(false);
	// Joining is a local Profile's: a remote Window shows its one Host.
	if (remote) return null;
	// A divider only between sections that both show something.
	const shows = entries.map(
		(e) =>
			!collapsed ||
			(!folded.includes(`host:${e.hostId}`) &&
				workspaces.some((w) => w.joined?.hostId === e.hostId)),
	);
	const dividers = dividersBefore([ownShows, ...shows]).slice(1);
	if (collapsed) {
		return (
			<>
				{entries.map((e, i) =>
					shows[i] ? (
						<CollapsedJoined
							key={e.hostId}
							entry={e}
							divider={dividers[i]}
							render={renderCollapsed}
						/>
					) : null,
				)}
			</>
		);
	}
	return (
		<>
			{entries.map((e, i) => (
				<JoinedSection
					key={e.hostId}
					entry={e}
					renderRows={renderRows}
					divider={dividers[i]}
				/>
			))}
			<button
				type="button"
				className="flex items-center gap-2 text-left rounded-md hover:bg-[var(--bg-tertiary)] transition-colors"
				style={{
					margin: "6px 8px 4px",
					padding: "5px 8px",
					fontSize: 12,
					color: "var(--fg-secondary)",
				}}
				onClick={() => setJoining(true)}
			>
				<Plus size={13} />
				Join remote profile…
			</button>
			{joining && (
				<OpenRemoteProfileDialog
					mode="join"
					onClose={() => setJoining(false)}
				/>
			)}
		</>
	);
}

/** The line between two sections of the Workspace list. */
export function SectionDivider({ short = false }: { short?: boolean }) {
	return (
		<hr
			style={{
				height: 1,
				border: "none",
				margin: short ? "6px 12px" : "10px 8px 4px",
				backgroundColor: "var(--border)",
			}}
		/>
	);
}

/** A Joined profile's Workspaces in the collapsed sidebar: strips under a
 *  divider, dimmed while its Host is away (hover says so). */
function CollapsedJoined({
	entry,
	divider,
	render,
}: {
	entry: JoinedEntry;
	divider: boolean;
	render?: (workspaces: WorkspaceWithTabs[]) => ReactNode;
}) {
	const link = useJoinedStore((s) => s.links[entry.hostId]);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const mine = useMemo(
		() => workspaces.filter((w) => w.joined?.hostId === entry.hostId),
		[workspaces, entry.hostId],
	);
	const offline = link?.state !== "online";
	return (
		<section aria-label={`${entry.hostName} · ${entry.remoteProfileName}`}>
			{divider && <SectionDivider short />}
			<div
				title={
					offline
						? `${entry.hostName} is not connected`
						: `${entry.hostName} · ${entry.remoteProfileName}`
				}
				style={{
					opacity: offline ? 0.5 : 1,
					pointerEvents: offline ? "none" : undefined,
				}}
				aria-disabled={offline}
			>
				{render?.(mine)}
			</div>
		</section>
	);
}

function JoinedSection({
	entry,
	renderRows,
	divider,
}: {
	entry: JoinedEntry;
	renderRows: (workspaces: WorkspaceWithTabs[], offline: boolean) => ReactNode;
	divider: boolean;
}) {
	const link = useJoinedStore((s) => s.links[entry.hostId]);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const mine = useMemo(
		() => workspaces.filter((w) => w.joined?.hostId === entry.hostId),
		[workspaces, entry.hostId],
	);
	const sectionKey = `host:${entry.hostId}`;
	const folded = useSectionFolded(sectionKey);
	const online = link?.state === "online";
	const offline = !online;
	const dot =
		link?.state === "online"
			? "var(--success, #3fb950)"
			: link?.state === "connecting"
				? "var(--warning, #d29922)"
				: "var(--fg-secondary)";
	const away =
		link?.state === "offline"
			? link.signIn
				? "Sign in needed"
				: lastSeen(entry.lastSeenMs)
			: link?.state === "connecting"
				? "Connecting…"
				: null;
	return (
		<section aria-label={`${entry.hostName} · ${entry.remoteProfileName}`}>
			{divider ? <SectionDivider /> : <div style={{ height: 10 }} />}
			<WorkspaceSectionHeader
				sectionKey={sectionKey}
				icon={<Cloud size={12} />}
				label={`${entry.hostName} · ${entry.remoteProfileName}`}
				title={link?.state === "offline" ? link.reason : undefined}
				workspaces={mine}
				trailing={
					<>
						<span
							role="img"
							aria-label={online ? "connected" : "not connected"}
							style={{
								width: 7,
								height: 7,
								borderRadius: 4,
								flexShrink: 0,
								backgroundColor: dot,
							}}
						/>
						<button
							type="button"
							aria-label={`${entry.hostName} menu`}
							className="opacity-0 group-hover:opacity-100 w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-opacity"
							style={{ color: "var(--fg-secondary)" }}
							onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
						>
							<MoreHorizontal size={13} />
						</button>
					</>
				}
				status={
					away && (
						<span className="flex items-center gap-2">
							<span>{away}</span>
							{link?.state === "offline" && (
								<button
									type="button"
									className="rounded hover:underline"
									style={{ color: "var(--accent)", fontSize: 11 }}
									onClick={() =>
										void useJoinedStore.getState().signIn(entry.hostId)
									}
								>
									{link.signIn ? "Sign in" : "Try now"}
								</button>
							)}
						</span>
					)
				}
			/>
			{!folded && (
				<div
					style={{
						opacity: offline ? 0.5 : 1,
						pointerEvents: offline ? "none" : undefined,
					}}
					aria-disabled={offline}
				>
					{renderRows(mine, offline)}
				</div>
			)}
			{menu && (
				<PaneContextMenu
					x={menu.x}
					y={menu.y}
					items={[
						{
							label: `Leave ${entry.remoteProfileName}`,
							onClick: () => void useJoinedStore.getState().leave(entry.hostId),
						},
					]}
					onClose={() => setMenu(null)}
				/>
			)}
		</section>
	);
}
