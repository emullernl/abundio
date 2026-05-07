import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PaneNode, WorkspaceWithTabs } from "../../lib/types";
import {
	computeWorkspaceDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { GitBranch, X } from "../Icons";

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
}

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

function useWorkspaceDotStatus(workspace: WorkspaceWithTabs): DotStatus {
	const tabLayouts = useMemo(() => {
		const layouts: PaneNode[] = [];
		for (const tab of workspace.tabs) {
			try {
				layouts.push(JSON.parse(tab.layoutJson) as PaneNode);
			} catch {
				// ignore
			}
		}
		return layouts;
	}, [workspace.tabs]);

	return usePtyActivityStore((s) => {
		return computeWorkspaceDotStatus(
			workspace.id,
			tabLayouts,
			s.activities,
			s.openedWorkspaceIds,
			s.panePtyMap,
		);
	});
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
}: Props) {
	const dotStatus = useWorkspaceDotStatus(workspace);
	const gitInfo = useWorkspaceGitStore((s) => s.byWorkspaceId[workspace.id]);
	// A workspace is "loaded" once it has been opened in this session.
	// Loaded (but not active) workspaces keep the accent chip and change stats.
	// Workspaces that have never been opened only show the cached branch name, dimmed.
	const isLoaded = usePtyActivityStore((s) => s.openedWorkspaceIds.has(workspace.id));

	const [renameValue, setRenameValue] = useState(workspace.name);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isRenaming) {
			setRenameValue(workspace.name);
			// Focus after React renders the input
			requestAnimationFrame(() => inputRef.current?.select());
		}
	}, [isRenaming, workspace.name]);

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
			role="button"
			tabIndex={0}
			onMouseDown={onMouseDown}
			onClick={onClick}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
			onContextMenu={onContextMenu}
			className="group flex items-start gap-2.5 pr-3 py-2.5 rounded-lg cursor-pointer transition-colors select-none"
			style={{
				paddingLeft: 20,
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
			<div style={{ marginTop: 3 }}>
				<AgentStatusIcon
					status={dotStatus}
					bgColor={isActive ? "var(--bg-tertiary)" : "var(--bg-secondary)"}
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
					{isLoaded && gitInfo?.isGitRepo && (gitInfo.changedFileCount > 0) && (
						<span
							className="flex items-center gap-1 flex-shrink-0"
							style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
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
