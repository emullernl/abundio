import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pr } from "../../lib/ipc";
import type { GhStatus } from "../../lib/types";
import {
	type MyPrsView,
	PR_VIEW_LABELS,
	type PrSectionState,
	type PrView,
	type ReviewView,
	usePrStore,
	visiblePrs,
} from "../../stores/prStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ChevronDown, GitPullRequest, RefreshCw } from "../Icons";
import { PullRequestItem } from "./PullRequestItem";

export function PullRequestsSection() {
	const ghStatus = usePrStore((s) => s.ghStatus);
	const reviewRequested = usePrStore((s) => s.reviewRequested);
	const mine = usePrStore((s) => s.mine);
	const loading = usePrStore((s) => s.loading);
	const error = usePrStore((s) => s.error);
	const activeRepoSlug = usePrStore((s) => s.activeRepoSlug);
	const refreshing = usePrStore((s) => s.refreshing);
	const reviewView = usePrStore((s) => s.reviewView);
	const myPrsView = usePrStore((s) => s.myPrsView);
	const setReviewView = usePrStore((s) => s.setReviewView);
	const setMyPrsView = usePrStore((s) => s.setMyPrsView);
	const prPollEnabled = useSettingsStore((s) => s.prPollEnabled);

	// No Opened workspaces: there is no repo context, so both sections show
	// their account-wide (-all) view and the repo/all selector is locked. The
	// stored per-section preference is left untouched and restored when a
	// workspace reopens. See CONTEXT.md / ADR-0019.
	const noWorkspace = usePtyActivityStore(
		(s) => s.openedWorkspaceIds.size === 0,
	);
	const hasRepo = !!activeRepoSlug;
	const effReviewView: ReviewView = noWorkspace ? "review-all" : reviewView;
	const effMyPrsView: MyPrsView = noWorkspace ? "mine-all" : myPrsView;

	// Client-side All-vs-Repo filtering over the one account-wide dataset, using
	// the shared `visiblePrs` rule with this panel's effective view.
	const reviewPrs = useMemo(
		() =>
			visiblePrs(
				reviewRequested,
				effReviewView === "review-repo",
				activeRepoSlug,
			),
		[effReviewView, activeRepoSlug, reviewRequested],
	);
	const myPrsList = useMemo(
		() => visiblePrs(mine, effMyPrsView === "mine-repo", activeRepoSlug),
		[effMyPrsView, activeRepoSlug, mine],
	);

	const reviewSection: PrSectionState = { prs: reviewPrs, loading, error };
	const myPrsSection: PrSectionState = { prs: myPrsList, loading, error };

	// Manual Refresh triggers an immediate app-global poll (works even when
	// automatic polling is off). The result is broadcast to every Window.
	// `beginRefresh` spins the icon until the poller pushes the next payload
	// (`applyPrState` clears it) — `pr.refresh()` itself resolves before the
	// poll finishes, so it can't gate the spinner.
	const handleRefresh = useCallback(() => {
		usePrStore.getState().beginRefresh();
		pr.refresh().catch(() => {});
	}, []);

	// Safety net: if the poller never pushes a payload (e.g. dead thread), stop
	// spinning after a generous timeout so the icon doesn't hang forever.
	useEffect(() => {
		if (!refreshing) return;
		const t = setTimeout(
			() => usePrStore.setState({ refreshing: false }),
			15000,
		);
		return () => clearTimeout(t);
	}, [refreshing]);

	// Switching repo↔all is purely client-side now — no refetch.
	const handleReviewViewChange = useCallback(
		(view: ReviewView) => setReviewView(view),
		[setReviewView],
	);
	const handleMyPrsViewChange = useCallback(
		(view: MyPrsView) => setMyPrsView(view),
		[setMyPrsView],
	);

	return (
		<div className="flex flex-col h-full min-h-0">
			<PrSubPanel
				views={["review-all", "review-repo"]}
				activeView={effReviewView}
				setActiveView={handleReviewViewChange}
				locked={noWorkspace}
				section={reviewSection}
				ghStatus={ghStatus}
				hasRepo={hasRepo}
				pollEnabled={prPollEnabled}
				onRefresh={handleRefresh}
				refreshing={refreshing}
				showRefresh
				showPrStatus
			/>
			<div
				className="flex-shrink-0"
				style={{ height: 1, backgroundColor: "var(--border)" }}
			/>
			<PrSubPanel
				views={["mine-all", "mine-repo"]}
				activeView={effMyPrsView}
				setActiveView={handleMyPrsViewChange}
				locked={noWorkspace}
				section={myPrsSection}
				ghStatus={ghStatus}
				hasRepo={hasRepo}
				pollEnabled={prPollEnabled}
				onRefresh={handleRefresh}
				showRefresh={false}
				showPrStatus
			/>
		</div>
	);
}

function openGithubSettings() {
	invoke("open_settings_window", { section: "github" }).catch(() => {});
}

interface PrSubPanelProps<V extends PrView> {
	views: V[];
	activeView: V;
	setActiveView: (view: V) => void;
	/** No Opened workspace: render the view as a static `(All)` label instead of
	 *  a dropdown, since the repo/all choice is meaningless with no repo. */
	locked?: boolean;
	section: PrSectionState;
	ghStatus: GhStatus | null;
	/** Whether the active workspace resolved to a GitHub repo (owner/repo). */
	hasRepo: boolean;
	/** Whether automatic PR polling is enabled (Settings → GitHub). */
	pollEnabled: boolean;
	onRefresh: () => void;
	/** Manual refresh in flight — spins the refresh icon. */
	refreshing?: boolean;
	showRefresh: boolean;
	showPrStatus?: boolean;
}

function PrSubPanel<V extends PrView>({
	views,
	activeView,
	setActiveView,
	locked,
	section,
	ghStatus,
	hasRepo,
	pollEnabled,
	onRefresh,
	refreshing,
	showRefresh,
	showPrStatus,
}: PrSubPanelProps<V>) {
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Close dropdown on click outside
	useEffect(() => {
		if (!dropdownOpen) return;
		function handleClickOutside(e: MouseEvent) {
			if (
				dropdownRef.current &&
				!dropdownRef.current.contains(e.target as Node)
			) {
				setDropdownOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [dropdownOpen]);

	const isRepoView = activeView === "review-repo" || activeView === "mine-repo";

	return (
		<div className="flex flex-col min-h-0" style={{ flex: "1 1 0%" }}>
			{/* Header */}
			<div
				className="flex items-center gap-2 py-2 flex-shrink-0"
				style={{
					borderBottom: "1px solid var(--border)",
					paddingLeft: 12,
					paddingRight: 12,
				}}
			>
				<GitPullRequest
					size={14}
					style={{ color: "var(--accent)", flexShrink: 0 }}
				/>

				{/* View selector dropdown. Locked (no Opened workspace) → a
				    non-interactive static label, since repo/all is meaningless. */}
				<div className="relative" ref={dropdownRef}>
					<button
						type="button"
						onClick={() => setDropdownOpen((o) => !o)}
						disabled={locked}
						className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors"
						style={{
							backgroundColor: "var(--bg-tertiary)",
							color: "var(--accent)",
							fontSize: 11,
							height: 24,
							fontFamily: "var(--font-mono)",
							border: "1px solid transparent",
							cursor: locked ? "default" : "pointer",
						}}
						onMouseEnter={(e) => {
							if (!locked) e.currentTarget.style.borderColor = "var(--border)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.borderColor = "transparent";
						}}
					>
						<span className="truncate" style={{ maxWidth: 160 }}>
							{PR_VIEW_LABELS[activeView]}
						</span>
						{!locked && <ChevronDown size={10} />}
					</button>

					{!locked && dropdownOpen && (
						<div
							className="absolute top-full left-0 mt-1 rounded-lg overflow-hidden shadow-lg"
							style={{
								backgroundColor: "var(--bg-secondary)",
								border: "1px solid var(--border)",
								width: 220,
								zIndex: 50,
							}}
						>
							{views.map((view) => (
								<button
									key={view}
									type="button"
									onClick={() => {
										setActiveView(view);
										setDropdownOpen(false);
									}}
									className="w-full text-left px-3 py-1.5 transition-colors"
									style={{
										fontSize: 12,
										color:
											view === activeView
												? "var(--accent)"
												: "var(--fg-primary)",
										backgroundColor:
											view === activeView
												? "var(--bg-tertiary)"
												: "transparent",
										borderLeft:
											view === activeView
												? "2px solid var(--accent)"
												: "2px solid transparent",
									}}
									onMouseEnter={(e) => {
										if (view !== activeView)
											e.currentTarget.style.backgroundColor =
												"var(--bg-tertiary)";
									}}
									onMouseLeave={(e) => {
										if (view !== activeView)
											e.currentTarget.style.backgroundColor = "transparent";
									}}
								>
									{PR_VIEW_LABELS[view]}
								</button>
							))}
						</div>
					)}
				</div>

				<div className="flex-1" />

				{/* Count */}
				{section.prs.length > 0 && (
					<span
						className="flex-shrink-0"
						style={{
							fontSize: 11,
							color: "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
						}}
					>
						{section.prs.length}
					</span>
				)}

				{showRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						className="flex items-center justify-center rounded w-6 h-6 transition-colors flex-shrink-0"
						style={{ color: "var(--fg-secondary)" }}
						onMouseEnter={(e) => {
							e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
							e.currentTarget.style.color = "var(--fg-primary)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.backgroundColor = "transparent";
							e.currentTarget.style.color = "var(--fg-secondary)";
						}}
						title="Refresh"
					>
						<RefreshCw
							size={12}
							className={refreshing ? "animate-spin" : undefined}
						/>
					</button>
				)}
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{!pollEnabled && section.prs.length === 0 ? (
					// Checked ahead of the status/loading gates: with polling Off and
					// no data, the poller never broadcasts, so `ghStatus`/`loading`
					// would otherwise show "Checking GitHub CLI…" forever on a cold
					// start. Manual Refresh still populates it.
					<StatusMessage>
						<span
							style={{
								fontWeight: 500,
								color: "var(--fg-primary)",
								marginBottom: 4,
								display: "block",
							}}
						>
							Pull request polling is off
						</span>
						<button
							type="button"
							onClick={openGithubSettings}
							style={{
								color: "var(--accent)",
								background: "none",
								border: "none",
								padding: 0,
								cursor: "pointer",
								font: "inherit",
							}}
						>
							Enable in Settings
						</button>
					</StatusMessage>
				) : !ghStatus ? (
					<StatusMessage>Checking GitHub CLI...</StatusMessage>
				) : !ghStatus.available ? (
					<StatusMessage>
						<span
							style={{
								fontWeight: 500,
								color: "var(--fg-primary)",
								marginBottom: 4,
								display: "block",
							}}
						>
							gh CLI not found
						</span>
						Install from{" "}
						<span
							style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}
						>
							cli.github.com
						</span>
					</StatusMessage>
				) : !ghStatus.authenticated ? (
					<StatusMessage>
						<span
							style={{
								fontWeight: 500,
								color: "var(--fg-primary)",
								marginBottom: 4,
								display: "block",
							}}
						>
							gh not authenticated
						</span>
						Run{" "}
						<span
							style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}
						>
							gh auth login
						</span>
					</StatusMessage>
				) : isRepoView && !hasRepo ? (
					<StatusMessage>No GitHub remote found</StatusMessage>
				) : section.loading && section.prs.length === 0 ? (
					<StatusMessage>
						<span className="animate-pulse">Loading pull requests...</span>
					</StatusMessage>
				) : section.error && section.prs.length === 0 ? (
					<StatusMessage>{section.error}</StatusMessage>
				) : section.prs.length === 0 ? (
					<StatusMessage>No pull requests</StatusMessage>
				) : (
					<div className="flex flex-col">
						{section.prs.map((pr) => (
							<PullRequestItem
								key={`${pr.repository || "local"}-${pr.number}`}
								pr={pr}
								showStatus={showPrStatus}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function StatusMessage({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="flex items-center justify-center h-20 px-4 text-center"
			style={{ color: "var(--fg-secondary)", fontSize: 12 }}
		>
			<div>{children}</div>
		</div>
	);
}
