import { Cloud } from "lucide-react";
import { useJoinedStore } from "../stores/joinedStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** The Host a Joined profile's Workspace is on, by name; `null` for one of
 *  this Window's own (phase 10). */
export function useJoinedHostName(
	workspaceId: string | null | undefined,
): string | null {
	const hostId = useWorkspaceStore((s) =>
		workspaceId
			? (s.workspaces.find((w) => w.id === workspaceId)?.joined?.hostId ?? null)
			: null,
	);
	return useJoinedStore((s) =>
		hostId
			? (s.entries.find((e) => e.hostId === hostId)?.hostName ?? hostId)
			: null,
	);
}

/**
 * The **Host chip** (docs/plans/remote-hosts.md phase 10): `☁ host` beside
 * anything of a Joined profile's Workspace (an Agent row, a Fleet tile, a
 * Navigator row), so it is never taken for one of this Window's own. Draws
 * nothing for this Window's own Workspaces.
 */
export function HostChip({
	workspaceId,
}: {
	workspaceId: string | null | undefined;
}) {
	const host = useJoinedHostName(workspaceId);
	if (!host) return null;
	return (
		<span
			className="inline-flex items-center flex-shrink-0 rounded"
			data-testid="host-chip"
			title={`On ${host}`}
			style={{
				gap: 3,
				padding: "0 4px",
				fontSize: 10,
				lineHeight: "14px",
				color: "var(--fg-secondary)",
				border: "1px solid var(--border)",
				maxWidth: 110,
			}}
		>
			<Cloud size={9} style={{ flexShrink: 0 }} />
			<span className="truncate">{host}</span>
		</span>
	);
}
