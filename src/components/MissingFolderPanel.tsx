import { useState } from "react";
import type { WorkspaceWithTabs } from "../lib/types";
import { useWorkspaceRemoveRequestStore } from "../stores/workspaceRemoveRequestStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { FolderX } from "./Icons";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "./PromptActions/fieldStyles";

/**
 * Shown in place of a **Missing folder** Workspace's panes (ADR-0053). The
 * Workspace is Active but not Opened, so nothing has started. When the folder
 * comes back the store opens the Workspace and this panel goes away.
 */
export function MissingFolderPanel({
	workspace,
}: {
	workspace: WorkspaceWithTabs;
}) {
	const [checking, setChecking] = useState(false);
	const [stillMissing, setStillMissing] = useState(false);

	const tryAgain = async () => {
		setChecking(true);
		setStillMissing(false);
		await useWorkspaceStore.getState().refreshMissingFolders();
		setChecking(false);
		// Still here means still missing; on success the panel unmounts.
		setStillMissing(
			useWorkspaceStore.getState().missingFolderIds.has(workspace.id),
		);
	};

	return (
		<div
			data-missing-folder-panel
			className="flex items-center justify-center flex-1 min-w-0 overflow-hidden"
			style={{
				padding: "0 16px",
				background: "var(--ambient-glow-top), var(--bg-primary)",
			}}
		>
			<div
				className="flex flex-col items-center text-center max-w-full"
				style={{ gap: 12, width: 420 }}
			>
				<span style={{ color: "var(--warning)" }}>
					<FolderX size={36} strokeWidth={1.75} />
				</span>
				<div
					className="font-medium"
					style={{ fontSize: 16, color: "var(--fg-primary)" }}
				>
					Folder not found
				</div>
				<div
					className="max-w-full break-all"
					style={{
						fontSize: 12,
						fontFamily: "var(--font-mono)",
						color: "var(--fg-secondary)",
					}}
				>
					{workspace.rootFolder}
				</div>
				<p
					style={{
						fontSize: 12.5,
						lineHeight: 1.55,
						color: "var(--fg-secondary)",
					}}
				>
					Nothing has been started for “{workspace.name}”. If the folder is on a
					drive or share that isn't connected, connect it and try again.
				</p>
				{stillMissing && (
					<div role="status" style={{ fontSize: 12, color: "var(--warning)" }}>
						Still not found.
					</div>
				)}
				<div className="flex" style={{ gap: 8, marginTop: 4 }}>
					<button
						type="button"
						disabled={checking}
						onClick={() => void tryAgain()}
						className={`${primaryButtonClass} rounded-md font-medium`}
						style={{
							padding: "7px 14px",
							fontSize: 12.5,
							background: "var(--accent)",
							color: "var(--bg-primary)",
						}}
					>
						{checking ? "Checking…" : "Try again"}
					</button>
					<button
						type="button"
						onClick={() =>
							useWorkspaceRemoveRequestStore
								.getState()
								.requestRemove(workspace.id)
						}
						className={`${secondaryButtonClass} rounded-md`}
						style={{ padding: "7px 14px", fontSize: 12.5 }}
					>
						Remove workspace
					</button>
				</div>
			</div>
		</div>
	);
}
