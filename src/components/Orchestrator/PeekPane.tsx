import { useEffect, useMemo } from "react";
import { closePeek, focusPeek } from "../../lib/orchestratorActions";
import { findPaneLocation, switchToPane } from "../../lib/paneLocation";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { requestPaneClose } from "../../stores/paneCloseConfirmStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { TerminalSlot } from "../Terminal/TerminalSlot";

/**
 * **Peek** (ADR-0057): one Agent's live terminal in the Orchestrator view's
 * Peek tab. The same terminal, borrowed from its Workspace the way a Fleet
 * tile borrows it (it registers above the Workspace-view slot and hands the
 * terminal back when it goes), fully interactive, at its normal size. Ends
 * when the Agent leaves agent mode or its pane closes.
 */
export function PeekPane({ paneId }: { paneId: string }) {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const gitById = useWorkspaceGitStore((s) => s.byWorkspaceId);
	const ptyId = usePtyActivityStore((s) => s.panePtyMap[paneId]);
	const isAgent = usePtyActivityStore((s) =>
		ptyId ? s.activities[ptyId]?.detectionMode === "agent" : false,
	);
	const agentId = usePtyActivityStore((s) =>
		ptyId ? s.detectedAgentIds[ptyId] : undefined,
	);
	const where = useMemo(() => {
		const loc = findPaneLocation(paneId);
		const ws = loc && workspaces.find((w) => w.id === loc.workspaceId);
		const tab = ws?.tabs.find((t) => t.id === loc?.tabId);
		return ws && tab ? { ws, tab } : null;
	}, [workspaces, paneId]);

	// The Agent left (it exited, or its pane closed): the Peek goes with it.
	useEffect(() => {
		if (!where || (ptyId && !isAgent)) closePeek();
	}, [where, ptyId, isAgent]);

	// Focus is the Peek's own, like a Fleet tile's: clicking into it takes
	// it, and focusing a pane of the Workspace below (or a file tab) gives it
	// up. It is in the store so pane shortcuts can find it (`targetPaneId`).
	const focused = useOrchestratorStore((s) => s.peekFocused);
	useEffect(() => {
		const giveUp = () => {
			if (useOrchestratorStore.getState().peekFocused) {
				useOrchestratorStore.getState().set({ peekFocused: false });
			}
		};
		const stopStore = useWorkspaceStore.subscribe((s, prev) => {
			if (s.focusedPaneId !== prev.focusedPaneId) giveUp();
		});
		// A click into the pane that is already the Focused pane changes no
		// store value, so watch focus itself too.
		const onFocusIn = (e: FocusEvent) => {
			const el = e.target instanceof Element ? e.target : null;
			if (el?.closest("[data-pane-id]") && !el.closest("[data-peek-pane]")) {
				giveUp();
			}
		};
		document.addEventListener("focusin", onFocusIn);
		return () => {
			stopStore();
			document.removeEventListener("focusin", onFocusIn);
		};
	}, []);

	const workspaceName = where?.ws.name ?? "";
	const tabName = where?.tab.name ?? "";
	const branch =
		(where && gitById[where.ws.id]?.currentBranch) ??
		where?.ws.lastBranch ??
		null;
	const fleet = useMemo(
		() => ({
			workspaceName,
			branch,
			tabName,
			onSwitchTo: () => switchToPane(paneId),
			spotlighted: false,
			noClose: true,
		}),
		[workspaceName, branch, tabName, paneId],
	);

	if (!where) return null;
	return (
		<div
			data-peek-pane
			className="absolute flex"
			style={{
				inset: 8,
				borderRadius: 8,
				overflow: "hidden",
				border: `1px solid ${
					focused
						? "color-mix(in srgb, var(--accent) 70%, transparent)"
						: "color-mix(in srgb, var(--border) 80%, transparent)"
				}`,
			}}
		>
			<div className="flex-1 min-w-0 min-h-0">
				<TerminalSlot
					paneId={paneId}
					agentId={agentId}
					fleet={fleet}
					isFocused={focused}
					onFocus={focusPeek}
					onSplitHorizontal={() => {}}
					onSplitVertical={() => {}}
					onClose={() =>
						requestPaneClose(paneId, `${workspaceName} · ${tabName}`)
					}
				/>
			</div>
		</div>
	);
}
