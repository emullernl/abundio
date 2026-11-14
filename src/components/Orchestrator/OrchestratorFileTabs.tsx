import { useEffect } from "react";
import {
	ORCHESTRATOR_DIVIDER,
	ORCHESTRATOR_TAB_STRIP,
} from "../../lib/orchestratorLayout";
import {
	requestCloseOrchestratorTab,
	tabPaneId,
} from "../../lib/orchestratorTabs";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FilePane } from "../FileViewer/FilePane";

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
						<FilePane
							paneId={paneId}
							filePath={tab.path}
							cwd={ws.rootFolder}
							workspaceId={ws.id}
							isFocused={shown && isSelected && focused}
							onFocus={() =>
								useOrchestratorStore.getState().set({ fileTabFocused: true })
							}
							embedded={{
								onClose: () => requestCloseOrchestratorTab(tab.id),
								closeLabel: "Close Tab",
							}}
						/>
					</div>
				);
			})}
		</div>
	);
}
