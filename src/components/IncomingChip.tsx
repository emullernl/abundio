import {
	canPull,
	isDiverged,
	lastCheckedMs,
	upstreamTooltip,
} from "../lib/incomingCommits";
import { pullWorkspace } from "../lib/pull";
import { useGitChangesStore } from "../stores/gitChangesStore";
import { useIncomingStore } from "../stores/incomingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** ↓N (and, with `showOutgoing`, ↑M) for a Workspace's **Upstream**
 *  (ADR-0066). Clicking ↓N pulls, unless the branch is Diverged; nothing is
 *  drawn when there is nothing to say. */
export function IncomingChip({
	workspaceId,
	showOutgoing = false,
	fontSize = 10,
}: {
	workspaceId: string;
	showOutgoing?: boolean;
	fontSize?: number;
}) {
	const upstream = useIncomingStore((s) => s.upstreamById[workspaceId]);
	const pulling = useIncomingStore((s) => s.pulling.has(workspaceId));
	const error = useIncomingStore((s) => s.errorById[workspaceId] ?? null);
	const attempt = useIncomingStore((s) => s.lastAttemptById[workspaceId]);
	// Only the Active workspace's operation is mirrored; for another one Pull
	// itself refuses and says why.
	const operation = useGitChangesStore((s) =>
		useWorkspaceStore.getState().activeWorkspaceId === workspaceId
			? s.operationInProgress
			: null,
	);
	if (!upstream) return null;
	const { incoming, outgoing } = upstream;
	if (incoming === 0 && !(showOutgoing && outgoing > 0)) return null;

	const tooltip = upstreamTooltip(upstream, {
		lastMs: lastCheckedMs(attempt, upstream),
		error,
		operationInProgress: operation,
		now: Date.now(),
	});
	const pullable = canPull(upstream, operation) && !pulling;
	const diverged = isDiverged(upstream);
	return (
		<span
			className="inline-flex items-center gap-1 flex-shrink-0"
			style={{
				fontSize,
				lineHeight: 1,
				fontFamily: "var(--font-mono)",
				fontVariantNumeric: "tabular-nums",
			}}
		>
			{incoming > 0 && (
				<button
					type="button"
					aria-label={pullable ? `Pull ${incoming} incoming commits` : tooltip}
					title={tooltip}
					disabled={!pullable}
					onClick={(e) => {
						e.stopPropagation();
						void pullWorkspace(workspaceId);
					}}
					onMouseDown={(e) => e.stopPropagation()}
					className={`rounded transition-colors ${pullable ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--success)_18%,transparent)]" : "cursor-default"} ${pulling ? "animate-pulse" : ""}`}
					style={{
						padding: "2px 4px",
						color: diverged ? "var(--warning)" : "var(--success)",
						border:
							"1px solid color-mix(in srgb, currentColor 30%, transparent)",
						background: "transparent",
					}}
				>
					↓{incoming}
				</button>
			)}
			{showOutgoing && outgoing > 0 && (
				<span title={tooltip} style={{ color: "var(--fg-secondary)" }}>
					↑{outgoing}
				</span>
			)}
		</span>
	);
}
