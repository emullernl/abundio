import { useCallback, useEffect, useRef, useState } from "react";
import type { GhStatus } from "../../lib/types";
import {
	PR_VIEW_LABELS,
	type PrSectionState,
	type PrView,
	usePrStore,
} from "../../stores/prStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { ChevronDown, GitPullRequest, RefreshCw } from "../Icons";
import { PullRequestItem } from "./PullRequestItem";

const REFRESH_INTERVAL = 60_000;

export function PullRequestsSection() {
	const ghStatus = usePrStore((s) => s.ghStatus);
	const reviewView = usePrStore((s) => s.reviewView);
	const review = usePrStore((s) => s.review);
	const myPrsView = usePrStore((s) => s.myPrsView);
	const myPrs = usePrStore((s) => s.myPrs);
	const checkGhStatus = usePrStore((s) => s.checkGhStatus);
	const fetchReviewPrs = usePrStore((s) => s.fetchReviewPrs);
	const fetchMyPrs = usePrStore((s) => s.fetchMyPrs);
	const setReviewView = usePrStore((s) => s.setReviewView);
	const setMyPrsView = usePrStore((s) => s.setMyPrsView);
	const clear = usePrStore((s) => s.clear);

	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspace = workspaces.find((s) => s.id === activeWorkspaceId);
	const cwd = activeWorkspace?.rootFolder ?? null;

	// Clear immediately when the workspace changes — avoids showing stale PRs
	// from the previous workspace while the new fetch is in flight.
	// biome-ignore lint/correctness/useExhaustiveDependencies: cwd drives the reset
	useEffect(() => {
		clear();
	}, [cwd, clear]);

	// Check gh status on mount / session change
	useEffect(() => {
		if (!cwd) return;
		checkGhStatus(cwd);
	}, [cwd, checkGhStatus]);

	// Fetch review PRs when gh is ready, view changes, or session changes
	useEffect(() => {
		if (!cwd || !ghStatus?.available || !ghStatus?.authenticated) return;
		fetchReviewPrs(cwd);
	}, [cwd, ghStatus?.available, ghStatus?.authenticated, fetchReviewPrs]);

	// Fetch my PRs when gh is ready, view changes, or session changes
	useEffect(() => {
		if (!cwd || !ghStatus?.available || !ghStatus?.authenticated) return;
		fetchMyPrs(cwd);
	}, [cwd, ghStatus?.available, ghStatus?.authenticated, fetchMyPrs]);

	// Auto-refresh both sections
	useEffect(() => {
		if (!cwd || !ghStatus?.available || !ghStatus?.authenticated) return;
		const interval = setInterval(() => {
			fetchReviewPrs(cwd);
			fetchMyPrs(cwd);
		}, REFRESH_INTERVAL);
		return () => clearInterval(interval);
	}, [
		cwd,
		ghStatus?.available,
		ghStatus?.authenticated,
		fetchReviewPrs,
		fetchMyPrs,
	]);

	const handleRefresh = useCallback(async () => {
		if (cwd) {
			await checkGhStatus(cwd);
			fetchReviewPrs(cwd);
			fetchMyPrs(cwd);
		}
	}, [cwd, checkGhStatus, fetchReviewPrs, fetchMyPrs]);

	return (
		<div className="flex flex-col h-full min-h-0">
			<PrSubPanel
				views={["review-all", "review-repo"]}
				activeView={reviewView}
				setActiveView={setReviewView}
				section={review}
				ghStatus={ghStatus}
				onRefresh={handleRefresh}
				showRefresh
				showPrStatus
			/>
			<div
				className="flex-shrink-0"
				style={{ height: 1, backgroundColor: "var(--border)" }}
			/>
			<PrSubPanel
				views={["mine-all", "mine-repo"]}
				activeView={myPrsView}
				setActiveView={setMyPrsView}
				section={myPrs}
				ghStatus={ghStatus}
				onRefresh={handleRefresh}
				showRefresh={false}
				showPrStatus
			/>
		</div>
	);
}

interface PrSubPanelProps<V extends PrView> {
	views: V[];
	activeView: V;
	setActiveView: (view: V) => void;
	section: PrSectionState;
	ghStatus: GhStatus | null;
	onRefresh: () => void;
	showRefresh: boolean;
	showPrStatus?: boolean;
}

function PrSubPanel<V extends PrView>({
	views,
	activeView,
	setActiveView,
	section,
	ghStatus,
	onRefresh,
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

				{/* View selector dropdown */}
				<div className="relative" ref={dropdownRef}>
					<button
						type="button"
						onClick={() => setDropdownOpen((o) => !o)}
						className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors"
						style={{
							backgroundColor: "var(--bg-tertiary)",
							color: "var(--accent)",
							fontSize: 11,
							height: 24,
							fontFamily: "var(--font-mono)",
							border: "1px solid transparent",
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.borderColor = "var(--border)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.borderColor = "transparent";
						}}
					>
						<span className="truncate" style={{ maxWidth: 160 }}>
							{PR_VIEW_LABELS[activeView]}
						</span>
						<ChevronDown size={10} />
					</button>

					{dropdownOpen && (
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
						<RefreshCw size={12} />
					</button>
				)}
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{!ghStatus ? (
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
				) : !ghStatus.hasRemote && isRepoView ? (
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
