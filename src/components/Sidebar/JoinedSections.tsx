import { Cloud, MoreHorizontal, Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { WorkspaceWithTabs } from "../../lib/types";
import { type JoinedEntry, useJoinedStore } from "../../stores/joinedStore";
import { useProfileStore } from "../../stores/profileStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { OpenRemoteProfileDialog } from "../OpenRemoteProfileDialog";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";

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
}: {
	renderRows: (workspaces: WorkspaceWithTabs[], offline: boolean) => ReactNode;
}) {
	const entries = useJoinedStore((s) => s.entries);
	const remote = useProfileStore((s) => s.remote);
	const [joining, setJoining] = useState(false);
	// Joining is a local Profile's: a remote Window shows its one Host.
	if (remote) return null;
	return (
		<>
			{entries.map((e) => (
				<JoinedSection key={e.hostId} entry={e} renderRows={renderRows} />
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

function JoinedSection({
	entry,
	renderRows,
}: {
	entry: JoinedEntry;
	renderRows: (workspaces: WorkspaceWithTabs[], offline: boolean) => ReactNode;
}) {
	const link = useJoinedStore((s) => s.links[entry.hostId]);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const mine = workspaces.filter((w) => w.joined?.hostId === entry.hostId);
	const online = link?.state === "online";
	const offline = !online;
	const dot =
		link?.state === "online"
			? "var(--success, #3fb950)"
			: link?.state === "connecting"
				? "var(--warning, #d29922)"
				: "var(--fg-secondary)";
	const status =
		link?.state === "offline"
			? link.signIn
				? "Sign in needed"
				: lastSeen(entry.lastSeenMs)
			: link?.state === "connecting"
				? "Connecting…"
				: null;
	return (
		<section
			aria-label={`${entry.hostName} · ${entry.remoteProfileName}`}
			style={{ marginTop: 10 }}
		>
			<div
				className="group flex items-center gap-2"
				style={{ padding: "4px 8px 4px 12px" }}
			>
				<Cloud
					size={12}
					style={{ flexShrink: 0, color: "var(--fg-secondary)" }}
				/>
				<span
					className="truncate flex-1 min-w-0 uppercase"
					style={{
						fontSize: 10,
						letterSpacing: "0.06em",
						fontWeight: 600,
						color: "var(--fg-secondary)",
					}}
					title={link?.state === "offline" ? link.reason : undefined}
				>
					{entry.hostName} · {entry.remoteProfileName}
				</span>
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
			</div>
			{status && (
				<div
					className="flex items-center gap-2"
					style={{ padding: "0 12px 4px 32px", fontSize: 11 }}
				>
					<span style={{ color: "var(--fg-secondary)" }}>{status}</span>
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
				</div>
			)}
			<div
				style={{
					opacity: offline ? 0.5 : 1,
					pointerEvents: offline ? "none" : undefined,
				}}
				aria-disabled={offline}
			>
				{mine.length === 0 && online ? (
					<div
						style={{
							padding: "2px 12px 4px 32px",
							fontSize: 11,
							color: "var(--fg-secondary)",
						}}
					>
						No workspaces
					</div>
				) : (
					renderRows(mine, offline)
				)}
			</div>
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
