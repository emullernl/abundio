import { useEffect, useMemo, useRef, useState } from "react";
import type { PaneNode, WorkspaceWithTabs } from "../../lib/types";
import {
	computeWorkspaceDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { X } from "../Icons";

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

export function WorkspaceItem({
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
			className="group flex items-start gap-2.5 pr-3 py-2.5 rounded-lg cursor-pointer transition-colors"
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
				<AgentStatusIcon status={dotStatus} />
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
					<span
						className="truncate font-medium"
						style={{ color: "var(--fg-primary)", fontSize: 13 }}
					>
						{workspace.name}
					</span>
				)}
				<div
					className="truncate mt-0.5"
					style={{ color: "var(--fg-secondary)", fontSize: 11 }}
				>
					{shortenPath(workspace.rootFolder)}
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
}
