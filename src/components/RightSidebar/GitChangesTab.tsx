import { useState } from "react";
import { git } from "../../lib/ipc";
import type { GitChangedFile } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { BranchSelector } from "../GitChanges/BranchSelector";
import { GitChangesFileList } from "../GitChanges/GitChangesFileList";
import { NotAGitRepoEmpty } from "../GitChanges/NotAGitRepoEmpty";
import { RefreshCw } from "../Icons";

export function GitChangesTab() {
	const changedFiles = useGitChangesStore((s) => s.changedFiles);
	const baseBranch = useGitChangesStore((s) => s.baseBranch);
	const currentBranch = useGitChangesStore((s) => s.currentBranch);
	const loading = useGitChangesStore((s) => s.loading);
	const error = useGitChangesStore((s) => s.error);
	const fetchChanges = useGitChangesStore((s) => s.fetchChanges);

	const [selectedFile, setSelectedFile] = useState<GitChangedFile | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspace = workspaces.find((s) => s.id === activeWorkspaceId);
	const cwd = activeWorkspace?.rootFolder ?? null;
	const workspaceBaseBranch = activeWorkspace?.baseBranch ?? null;
	const isGitRepo = useWorkspaceGitStore((s) =>
		activeWorkspaceId
			? s.byWorkspaceId[activeWorkspaceId]?.isGitRepo
			: undefined,
	);

	async function handleSelectFile(file: GitChangedFile) {
		if (!cwd || !activeWorkspaceId) return;
		setSelectedFile(file);
		try {
			const diff = await git.fileDiff(
				cwd,
				file.path,
				file.section,
				workspaceBaseBranch,
			);
			useExplorerStore
				.getState()
				.openDiff(
					activeWorkspaceId,
					file.path,
					diff.original,
					diff.modified,
					file.section,
				);
		} catch {
			// Failed to load diff
		}
	}

	async function handleRefresh() {
		if (!cwd || refreshing) return;
		setRefreshing(true);
		try {
			// Floor the spin at a single rotation so a sub-second fetch reads as a
			// deliberate refresh rather than an icon twitch.
			await Promise.all([
				fetchChanges(cwd, workspaceBaseBranch),
				new Promise((resolve) => setTimeout(resolve, 600)),
			]);
		} finally {
			setRefreshing(false);
		}
	}

	if (isGitRepo === false) {
		return (
			<div className="flex-1 min-h-0">
				<NotAGitRepoEmpty />
			</div>
		);
	}

	const totalAdditions = changedFiles.reduce((s, f) => s + f.additions, 0);
	const totalDeletions = changedFiles.reduce((s, f) => s + f.deletions, 0);

	return (
		<div className="flex flex-col min-h-0 h-full">
			{/* Sub-header: branch selector + stats + refresh.
			 *  The tab strip above provides the section identity (icon + tooltip),
			 *  so this sub-header skips the label and goes straight to the controls. */}
			<div
				className="flex items-center gap-2 flex-shrink-0"
				style={{
					height: 30,
					paddingLeft: 10,
					paddingRight: 8,
					borderBottom: "1px solid var(--border)",
				}}
			>
				{cwd && activeWorkspaceId && (
					<BranchSelector cwd={cwd} workspaceId={activeWorkspaceId} />
				)}

				<div className="flex-1" />

				{changedFiles.length > 0 && (
					<span
						className="flex items-center gap-1 flex-shrink-0"
						style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
					>
						<span style={{ color: "var(--fg-secondary)" }}>
							{changedFiles.length}F
						</span>
						{totalAdditions > 0 && (
							<span style={{ color: "var(--success)" }}>+{totalAdditions}</span>
						)}
						{totalDeletions > 0 && (
							<span style={{ color: "var(--error)" }}>-{totalDeletions}</span>
						)}
					</span>
				)}

				<button
					type="button"
					onClick={handleRefresh}
					className="flex items-center justify-center rounded w-6 h-6 transition-colors flex-shrink-0"
					style={{
						color: "var(--fg-secondary)",
						transitionDuration: "var(--transition-fast)",
					}}
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
			</div>

			{currentBranch && (
				<div
					className="flex items-center gap-1.5 py-1.5 flex-shrink-0"
					style={{
						borderBottom: "1px solid var(--border)",
						backgroundColor:
							"color-mix(in srgb, var(--bg-tertiary) 30%, transparent)",
						paddingLeft: 12,
						paddingRight: 12,
					}}
				>
					<span style={{ fontSize: 11, color: "var(--fg-secondary)" }}>On</span>
					<span
						style={{
							fontSize: 11,
							color: "var(--fg-primary)",
							fontFamily: "var(--font-mono)",
							fontWeight: 500,
						}}
					>
						{currentBranch}
					</span>
				</div>
			)}

			<div className="flex-1 min-h-0 overflow-hidden flex flex-col">
				{loading && changedFiles.length === 0 ? (
					<div
						className="flex items-center justify-center h-32"
						style={{ color: "var(--fg-secondary)", fontSize: 13 }}
					>
						<span className="animate-pulse">Loading changes...</span>
					</div>
				) : error && changedFiles.length === 0 ? (
					<div
						className="flex items-center justify-center h-32 px-4 text-center"
						style={{ color: "var(--fg-secondary)", fontSize: 12 }}
					>
						{error}
					</div>
				) : !cwd ? (
					<div
						className="flex items-center justify-center h-32"
						style={{ color: "var(--fg-secondary)", fontSize: 13 }}
					>
						No workspace selected
					</div>
				) : (
					<div className="flex-1 overflow-y-auto">
						<GitChangesFileList
							files={changedFiles}
							baseBranch={baseBranch}
							onSelectFile={handleSelectFile}
							selectedFile={selectedFile}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
