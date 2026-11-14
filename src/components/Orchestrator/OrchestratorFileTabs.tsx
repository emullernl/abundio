import { useEffect } from "react";
import { commitDiffKey } from "../../lib/commitDiffKey";
import type { OrchestratorFileTab } from "../../lib/ipc";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { liveDiff } from "../../lib/liveDiff";
import {
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_TAB_STRIP,
} from "../../lib/orchestratorLayout";
import {
	requestCloseOrchestratorTab,
	tabPaneId,
} from "../../lib/orchestratorTabs";
import { useExplorerStore } from "../../stores/explorerStore";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FilePane } from "../FileViewer/FilePane";
import { PreviewPane } from "../FileViewer/PreviewPane";

/**
 * The files open in **Orchestrator tabs** (ADR-0058), each a File pane of
 * its own Workspace under its tab's own pane id, so editing, saving,
 * reloading and the quit dialog's unsaved edits all work as anywhere.
 *
 * Mounted for as long as the Window lives, not only while the Orchestrator
 * view is on screen: a File pane drops its buffer when it unmounts, and
 * closing the view must never lose an unsaved edit. Hidden unless the view
 * shows a file tab; placed over the view's top area.
 */
export function OrchestratorFileTabs({ topOffset }: { topOffset: number }) {
	const tabs = useOrchestratorStore((s) => s.fileTabs);
	const selected = useOrchestratorStore((s) => s.selectedTabId);
	const panesTop = useOrchestratorStore((s) => s.panesTop);
	const phase = useOrchestratorStore((s) => s.phase);
	const viewShown = useWindowUiStore(
		(s) => s.orchestratorViewOpen && !s.statisticsOverlayOpen,
	);
	const collapsed = useWindowUiStore((s) => s.orchestratorTopCollapsed);
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const focused = useOrchestratorStore((s) => s.fileTabFocused);

	// Focusing a pane below gives up the tab's focus (Save follows it).
	useEffect(
		() =>
			useWorkspaceStore.subscribe((s, prev) => {
				if (s.focusedPaneId !== prev.focusedPaneId) {
					useOrchestratorStore.getState().set({ fileTabFocused: false });
				}
			}),
		[],
	);

	if (tabs.length === 0) return null;
	const shown =
		viewShown &&
		phase === "ready" &&
		!collapsed &&
		selected !== null &&
		tabs.some((t) => t.id === selected);
	const height = Math.max(
		0,
		panesTop - ORCHESTRATOR_TAB_STRIP - ORCHESTRATOR_DIVIDER,
	);
	return (
		<div
			className="absolute"
			style={{
				top: topOffset + ORCHESTRATOR_TAB_STRIP,
				left: 0,
				right: 0,
				height,
				zIndex: 26,
				visibility: shown ? "visible" : "hidden",
				pointerEvents: shown ? "auto" : "none",
				background: "var(--bg-primary)",
			}}
		>
			{tabs.map((tab) => {
				const ws = workspaces.find((w) => w.id === tab.workspaceId);
				if (!ws) return null;
				const paneId = tabPaneId(tab.id);
				const isSelected = tab.id === selected;
				return (
					<div
						key={tab.id}
						className="absolute inset-0"
						style={{ display: isSelected ? "block" : "none" }}
					>
						<TabBody
							tab={tab}
							paneId={paneId}
							cwd={ws.rootFolder}
							workspaceId={ws.id}
							isFocused={shown && isSelected && focused}
							onFocus={() =>
								useOrchestratorStore.getState().set({ fileTabFocused: true })
							}
							onClose={() => requestCloseOrchestratorTab(tab.id)}
						/>
					</div>
				);
			})}
		</div>
	);
}

/** The File pane key a tab shows: the file, its live diff, or the file as a
 *  commit changed it. */
function paneKey(tab: OrchestratorFileTab): string {
	if (tab.kind === "diff") return `diff:${tab.path}`;
	if (tab.kind === "commit" && tab.commitOid) {
		return commitDiffKey(tab.commitOid, tab.path);
	}
	return tab.path;
}

/** One tab's content: its File pane, with the rendered markdown beside it
 *  when the tab asked for a preview. */
function TabBody({
	tab,
	paneId,
	cwd,
	workspaceId,
	isFocused,
	onFocus,
	onClose,
}: {
	tab: OrchestratorFileTab;
	paneId: string;
	cwd: string;
	workspaceId: string;
	isFocused: boolean;
	onFocus: () => void;
	onClose: () => void;
}) {
	const isDiff = tab.kind !== "file";
	const seeded = useExplorerStore((s) => !!s.filePanes[paneId]);
	// A live diff has no content until it is asked for; a commit diff the
	// File pane fetches itself.
	useEffect(() => {
		if (tab.kind !== "diff" || seeded) return;
		let cancelled = false;
		void liveDiff(cwd, tab.path).then((d) => {
			if (cancelled || !d) return;
			useExplorerStore
				.getState()
				.seedDiffPane(
					paneId,
					`diff:${tab.path}`,
					d.original,
					d.modified,
					d.section,
				);
		});
		return () => {
			cancelled = true;
		};
	}, [tab.kind, tab.path, cwd, paneId, seeded]);

	if (tab.kind === "diff" && !seeded) return null;
	const pane = (
		<FilePane
			paneId={paneId}
			filePath={paneKey(tab)}
			cwd={cwd}
			workspaceId={workspaceId}
			isDiff={isDiff}
			diffSource={isDiff ? "git" : undefined}
			isFocused={isFocused}
			onFocus={onFocus}
			embedded={{ onClose, closeLabel: "Close Tab" }}
		/>
	);
	if (!tab.preview || isDiff || !isMarkdownFile(tab.path)) return pane;
	return (
		<div className="flex w-full h-full">
			<div className="relative flex-1 min-w-0">{pane}</div>
			<div
				className="relative flex-1 min-w-0"
				style={{ borderLeft: "1px solid var(--border)" }}
			>
				<PreviewPane
					paneId={`${paneId}:preview`}
					sourcePaneId={paneId}
					isFocused={false}
					onFocus={onFocus}
				/>
			</div>
		</div>
	);
}
