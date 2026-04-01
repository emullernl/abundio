import { useCallback, useEffect, useRef, useState } from "react";
import { usePrStore, PR_VIEW_LABELS, type PrView } from "../../stores/prStore";
import { useSessionStore } from "../../stores/sessionStore";
import { PullRequestItem } from "./PullRequestItem";
import { GitPullRequest, RefreshCw, ChevronDown } from "../Icons";

const PR_VIEWS: PrView[] = ["review-all", "review-repo", "mine-all", "mine-repo"];
const REFRESH_INTERVAL = 60_000;

export function PullRequestsSection() {
	const ghStatus = usePrStore((s) => s.ghStatus);
	const activeView = usePrStore((s) => s.activeView);
	const prs = usePrStore((s) => s.prs);
	const loading = usePrStore((s) => s.loading);
	const error = usePrStore((s) => s.error);
	const checkGhStatus = usePrStore((s) => s.checkGhStatus);
	const fetchPrs = usePrStore((s) => s.fetchPrs);
	const setActiveView = usePrStore((s) => s.setActiveView);
	const clear = usePrStore((s) => s.clear);

	const [dropdownOpen, setDropdownOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const sessions = useSessionStore((s) => s.sessions);
	const activeSession = sessions.find((s) => s.id === activeSessionId);
	const cwd = activeSession?.rootFolder ?? null;

	// Check gh status on mount / session change
	useEffect(() => {
		if (!cwd) {
			clear();
			return;
		}
		checkGhStatus(cwd);
	}, [cwd, checkGhStatus, clear]);

	// Fetch PRs when gh is ready, view changes, or session changes
	useEffect(() => {
		if (!cwd || !ghStatus?.available || !ghStatus?.authenticated) return;
		fetchPrs(cwd);
	}, [cwd, ghStatus?.available, ghStatus?.authenticated, activeView, fetchPrs]);

	// Auto-refresh
	useEffect(() => {
		if (!cwd || !ghStatus?.available || !ghStatus?.authenticated) return;
		const interval = setInterval(() => fetchPrs(cwd), REFRESH_INTERVAL);
		return () => clearInterval(interval);
	}, [cwd, ghStatus?.available, ghStatus?.authenticated, activeView, fetchPrs]);

	// Close dropdown on click outside
	useEffect(() => {
		if (!dropdownOpen) return;
		function handleClickOutside(e: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setDropdownOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [dropdownOpen]);

	const handleRefresh = useCallback(async () => {
		if (cwd) {
			await checkGhStatus(cwd);
			fetchPrs(cwd);
		}
	}, [cwd, checkGhStatus, fetchPrs]);

	return (
		<div className="flex flex-col h-full min-h-0">
			{/* Header */}
			<div
				className="flex items-center gap-2 py-2 flex-shrink-0"
				style={{ borderBottom: "1px solid var(--border)", paddingLeft: 12, paddingRight: 12 }}
			>
				<GitPullRequest size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
				<span
					className="font-medium truncate"
					style={{ fontSize: 12, color: "var(--fg-primary)" }}
				>
					PRs
				</span>

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
							{PR_VIEWS.map((view) => (
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
										color: view === activeView ? "var(--accent)" : "var(--fg-primary)",
										backgroundColor: view === activeView ? "var(--bg-tertiary)" : "transparent",
										borderLeft: view === activeView ? "2px solid var(--accent)" : "2px solid transparent",
									}}
									onMouseEnter={(e) => {
										if (view !== activeView) e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
									}}
									onMouseLeave={(e) => {
										if (view !== activeView) e.currentTarget.style.backgroundColor = "transparent";
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
				{prs.length > 0 && (
					<span
						className="flex-shrink-0"
						style={{ fontSize: 11, color: "var(--fg-secondary)", fontFamily: "var(--font-mono)" }}
					>
						{prs.length}
					</span>
				)}

				<button
					type="button"
					onClick={handleRefresh}
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
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{!ghStatus ? (
					<StatusMessage>Checking GitHub CLI...</StatusMessage>
				) : !ghStatus.available ? (
					<StatusMessage>
						<span style={{ fontWeight: 500, color: "var(--fg-primary)", marginBottom: 4, display: "block" }}>
							gh CLI not found
						</span>
						Install from{" "}
						<span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
							cli.github.com
						</span>
					</StatusMessage>
				) : !ghStatus.authenticated ? (
					<StatusMessage>
						<span style={{ fontWeight: 500, color: "var(--fg-primary)", marginBottom: 4, display: "block" }}>
							gh not authenticated
						</span>
						Run{" "}
						<span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
							gh auth login
						</span>
					</StatusMessage>
				) : !ghStatus.hasRemote && (activeView === "review-repo" || activeView === "mine-repo") ? (
					<StatusMessage>No GitHub remote found</StatusMessage>
				) : loading && prs.length === 0 ? (
					<StatusMessage>
						<span className="animate-pulse">Loading pull requests...</span>
					</StatusMessage>
				) : error && prs.length === 0 ? (
					<StatusMessage>{error}</StatusMessage>
				) : prs.length === 0 ? (
					<StatusMessage>No pull requests</StatusMessage>
				) : (
					<div className="flex flex-col">
						{prs.map((pr) => (
							<PullRequestItem
								key={`${pr.repository || "local"}-${pr.number}`}
								pr={pr}
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
			className="flex items-center justify-center h-32 px-4 text-center"
			style={{ color: "var(--fg-secondary)", fontSize: 12 }}
		>
			<div>{children}</div>
		</div>
	);
}
