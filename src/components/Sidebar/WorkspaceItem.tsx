import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	type HiddenRollup,
	useWorkspaceRollups,
} from "../../hooks/useWorkspaceRollups";
import {
	branchStatTooltip,
	uncommittedTooltip,
} from "../../lib/dirtyWorkspace";
import { shortenPath } from "../../lib/shortenPath";
import { PRIMARY_SIZE } from "../../lib/statusComposite";
import type { WorkspaceWithTabs } from "../../lib/types";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { DirtyEdge, DirtyRing } from "../DirtyMarker";
import { ChevronRight, GitBranch, X } from "../Icons";
import { compositeWidth, StatusComposite } from "../StatusComposite";

// Fallback height for the collapsed sidebar's strip when no expanded
// WorkspaceItem has mounted yet to measure. Replaced at runtime by the
// `--workspace-item-height` CSS var written below.
export const WORKSPACE_ITEM_HEIGHT_FALLBACK = 56;

const WORKSPACE_ITEM_HEIGHT_LS_KEY = "abundio-workspace-item-height";

// Apply any persisted measurement IMMEDIATELY at module load so CollapsedStrip
// renders with the correct height even when the sidebar starts collapsed and
// no expanded WorkspaceItem mounts to measure. The runtime ResizeObserver
// inside WorkspaceItem keeps the CSS var fresh when one does mount (e.g. after
// the user expands the sidebar) — so font-size changes still update it.
if (typeof window !== "undefined") {
	try {
		const persisted = localStorage.getItem(WORKSPACE_ITEM_HEIGHT_LS_KEY);
		if (persisted) {
			const px = Number.parseInt(persisted, 10);
			if (Number.isFinite(px) && px > 0) {
				document.documentElement.style.setProperty(
					"--workspace-item-height",
					`${px}px`,
				);
			}
		}
	} catch {
		// no-op
	}
}

// Singleton ownership of the height-probe ResizeObserver. With N workspaces
// every instance previously mounted its own observer and re-wrote the same
// CSS variable — wasteful on every layout change and on every UI-font-size
// tweak. Only the first instance to mount claims ownership; later mounts
// no-op. If the owner unmounts, the next mounting instance reclaims; in
// the gap the CSS var retains its last-good value (correct until the next
// font/density change).
let heightObserverOwner: HTMLElement | null = null;

/** Fold affordance for a **Worktree set**'s Primary row. Present only on that
 *  row; every other row leaves it undefined and renders exactly as before.
 *  The chevron shares the status icon's 14px box (hover-swap) — the row has no
 *  spare left padding, and a dedicated gutter would cost every row width. */
export interface FoldControl {
	folded: boolean;
	toggle: () => void;
	/** Number of Linked worktrees in the set, for the toggle's tooltip. */
	memberCount: number;
	/** When set, folding is unavailable and why. A Folded set may not hide the
	 *  **Active workspace**, so an unfolded set holding it offers no chevron at
	 *  all rather than one that silently does nothing. */
	blockedReason?: string;
}

interface Props {
	workspace: WorkspaceWithTabs;
	isActive: boolean;
	isDragging: boolean;
	isRenaming: boolean;
	onClick: () => void;
	onDelete: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onRename: (name: string) => void;
	onRenameCancel: () => void;
	onMouseDown: (e: React.MouseEvent) => void;
	/** Set only on a Worktree set's Primary row. */
	fold?: FoldControl;
	/** Set only while that set is folded. */
	hidden?: HiddenRollup;
}

export const WorkspaceItem = memo(function WorkspaceItem({
	workspace,
	isActive,
	isDragging,
	isRenaming,
	onClick,
	onDelete,
	onContextMenu,
	onRename,
	onRenameCancel,
	onMouseDown,
	fold,
	hidden,
}: Props) {
	const rollups = useWorkspaceRollups(workspace);
	const gitInfo = useWorkspaceGitStore((s) => s.byWorkspaceId[workspace.id]);
	const uncommitted = useWorkspaceGitStore(
		(s) => s.uncommittedById[workspace.id],
	);
	// A workspace is "loaded" once it has been opened in this session.
	// Loaded (but not active) workspaces keep the accent chip and change stats.
	// Workspaces that have never been opened only show the cached branch name, dimmed.
	const isLoaded = usePtyActivityStore((s) =>
		s.openedWorkspaceIds.has(workspace.id),
	);

	const [renameValue, setRenameValue] = useState(workspace.name);
	const inputRef = useRef<HTMLInputElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (isRenaming) {
			setRenameValue(workspace.name);
			// Focus after React renders the input
			requestAnimationFrame(() => inputRef.current?.select());
		}
	}, [isRenaming, workspace.name]);

	// Publish the rendered height so CollapsedStrip can match it exactly.
	// Single-owner pattern — see `heightObserverOwner` at module scope.
	//
	// Also persists the measurement to localStorage. When the app restarts
	// with the sidebar already collapsed, no WorkspaceItem ever mounts to
	// take a measurement, so CollapsedStrips would fall back to the constant
	// 56 — wrong for any non-default font density. The persisted value is
	// applied to the CSS variable at module load (below) so collapsed
	// strips have the right height on first paint.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		if (heightObserverOwner !== null) return;
		heightObserverOwner = el;
		const write = () => {
			const px = el.offsetHeight;
			document.documentElement.style.setProperty(
				"--workspace-item-height",
				`${px}px`,
			);
			try {
				localStorage.setItem(WORKSPACE_ITEM_HEIGHT_LS_KEY, String(px));
			} catch {
				// localStorage quota / privacy mode — measurement still works
				// in-session, just won't survive restart.
			}
		};
		write();
		const ro = new ResizeObserver(write);
		ro.observe(el);
		return () => {
			ro.disconnect();
			if (heightObserverOwner === el) heightObserverOwner = null;
		};
	}, []);

	const commitRename = () => {
		const trimmed = renameValue.trim();
		if (trimmed && trimmed !== workspace.name) {
			onRename(trimmed);
		} else {
			onRenameCancel();
		}
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: div used intentionally for styling
		<div
			ref={rootRef}
			role="button"
			tabIndex={0}
			onMouseDown={onMouseDown}
			onClick={onClick}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
			onContextMenu={onContextMenu}
			className="group flex items-start gap-2.5 pr-3 py-2.5 rounded-lg cursor-pointer transition-colors select-none"
			style={{
				position: "relative",
				paddingLeft: 8,
				backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
				borderLeft: isActive
					? "2px solid var(--accent)"
					: "2px solid transparent",
				opacity: isDragging ? 0.4 : 1,
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				if (!isActive)
					e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
			}}
			onMouseLeave={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			{/* Left slot: one **Status composite** for the whole Workspace,
			    vertically centred across the name and path lines (ADR-0033).
			    On a Worktree set's Primary row it hover-swaps with the fold
			    chevron — there is no spare padding for a separate twisty, and a
			    gutter on every row would cost width the sidebar doesn't have.
			    The chevron covers the composite entirely, badge included, which
			    retires ADR-0032's "never fully covered" promise: that reasoning
			    assumed two separate icons. The row's Hidden rollup at the right
			    end stays visible throughout. */}
			<div
				className="flex self-center"
				style={{ width: compositeWidth(), flexShrink: 0 }}
			>
				<StatusComposite
					rollups={rollups}
					overlay={
						fold && !fold.blockedReason ? (
							<button
								type="button"
								// `mousedown` would otherwise start the set drag. No
								// `preventDefault()` — WorkspaceList's handler already bails on
								// anything inside a <button>, and preventing the default would
								// only cost the button its mouse focus.
								onMouseDown={(e) => {
									e.stopPropagation();
								}}
								onClick={(e) => {
									e.stopPropagation();
									fold.toggle();
								}}
								title={
									fold.folded
										? `Show ${fold.memberCount} linked worktree${fold.memberCount === 1 ? "" : "s"}`
										: "Hide linked worktrees"
								}
								aria-label={fold.folded ? "Unfold worktrees" : "Fold worktrees"}
								aria-expanded={!fold.folded}
								className="flex items-center justify-center w-full h-full"
								style={{ color: "var(--fg-primary)" }}
							>
								<ChevronRight
									size={PRIMARY_SIZE - 1}
									strokeWidth={2.5}
									style={{
										transform: fold.folded ? "none" : "rotate(90deg)",
										transition: "transform 150ms",
									}}
								/>
							</button>
						) : undefined
					}
				/>
			</div>
			<div className="flex-1 min-w-0">
				{isRenaming ? (
					<input
						ref={inputRef}
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						onBlur={commitRename}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") onRenameCancel();
						}}
						onClick={(e) => e.stopPropagation()}
						className="w-full bg-transparent outline-none font-medium rounded px-1 -mx-1"
						style={{
							color: "var(--fg-primary)",
							fontSize: 13,
							border: "1px solid var(--accent)",
						}}
					/>
				) : (
					<div className="flex items-center justify-between gap-2 min-w-0">
						<span
							className="truncate font-medium flex-shrink-0 max-w-[50%]"
							style={{ color: "var(--fg-primary)", fontSize: 13 }}
							title={workspace.name}
						>
							{workspace.name}
						</span>
						{gitInfo?.isGitRepo && gitInfo.currentBranch && (
							<div
								className="inline-flex items-center gap-1 rounded flex-shrink-0 min-w-0 max-w-[50%]"
								style={{
									backgroundColor: isLoaded
										? "color-mix(in srgb, var(--accent) 12%, transparent)"
										: "color-mix(in srgb, var(--fg-secondary) 8%, transparent)",
									border: isLoaded
										? "1px solid color-mix(in srgb, var(--accent) 22%, transparent)"
										: "1px solid color-mix(in srgb, var(--fg-secondary) 15%, transparent)",
									color: isLoaded ? "var(--accent)" : "var(--fg-secondary)",
									fontSize: 10,
									lineHeight: 1,
									paddingTop: 3,
									paddingBottom: 3,
									paddingLeft: 5,
									paddingRight: 5,
									fontFamily:
										"var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
								}}
								title={gitInfo.currentBranch}
							>
								<GitBranch
									size={9}
									strokeWidth={2.5}
									style={{ flexShrink: 0 }}
								/>
								<span className="truncate">{gitInfo.currentBranch}</span>
							</div>
						)}
					</div>
				)}
				<div className="flex items-center justify-between gap-2 mt-0.5 min-w-0">
					<span
						className="truncate"
						style={{ color: "var(--fg-secondary)", fontSize: 11 }}
					>
						{shortenPath(workspace.rootFolder)}
					</span>
					{isLoaded && gitInfo?.isGitRepo && gitInfo.changedFileCount > 0 && (
						<span
							className="flex items-center gap-1 flex-shrink-0"
							style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
							title={branchStatTooltip(gitInfo, workspace.baseBranch)}
						>
							<span style={{ color: "var(--fg-secondary)" }}>
								{gitInfo.changedFileCount}F
							</span>
							{gitInfo.additions > 0 && (
								<span style={{ color: "var(--success)" }}>
									+{gitInfo.additions}
								</span>
							)}
							{gitInfo.deletions > 0 && (
								<span style={{ color: "var(--error)" }}>
									-{gitInfo.deletions}
								</span>
							)}
						</span>
					)}
				</div>
			</div>
			{/* Hidden rollup — the Agent and Terminal rollups summed across the
			    Linked worktrees this folded set is hiding, drawn as one **Status
			    composite** (ADR-0033) followed by how many there are. One line
			    where it used to be two. Hidden members only: the left composite
			    still describes the workspace this row activates. */}
			{hidden && (
				// The member list covers the whole chip; the composite's own
				// breakdown wins while hovering it (innermost title).
				<div
					className="flex items-center gap-1 flex-shrink-0 self-center"
					data-hidden-rollup
					title={hidden.membersTooltip}
				>
					<StatusComposite
						rollups={
							hidden.notOpened
								? { agent: null, terminal: null, notOpened: true }
								: hidden
						}
					/>
					<span
						style={{
							fontSize: 10,
							lineHeight: 1,
							color: "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
						}}
					>
						{hidden.count}
					</span>
					{hidden.dirty && (
						<DirtyRing title="Uncommitted changes in a hidden worktree" />
					)}
				</div>
			)}
			{/* The row's own Dirty marker. Full strength on a never-opened
			    workspace too — uncommitted work nobody is looking at is the case
			    it exists for. */}
			{uncommitted?.dirty && (
				<DirtyEdge title={uncommittedTooltip(uncommitted)} />
			)}
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--error)] hover:text-white transition-all"
				style={{ color: "var(--fg-secondary)" }}
			>
				<X size={12} />
			</button>
		</div>
	);
});
