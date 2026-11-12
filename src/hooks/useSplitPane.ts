import { useCallback } from "react";
import { closePaneNow as closePaneNowById } from "../lib/closePane";
import { agentHooks } from "../lib/ipc";
import {
	cyclePane,
	findNode,
	neighbourInDirection,
	type PaneDirection,
	replaceNode,
	wrapInSplit,
} from "../lib/paneTree";
import { setPendingAgent } from "../lib/pendingAgentRegistry";
import type { CodingAgent, PaneNode } from "../lib/types";
import { requestPaneClose } from "../stores/paneCloseConfirmStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

function generateId(): string {
	return crypto.randomUUID();
}

/** Max time to wait for on-launch hook provisioning before letting the pane
 *  appear anyway. Hooks are picked up on the agent's next run if it times out,
 *  so a pathological slow disk / provision-mutex contention can't freeze the
 *  launch path. */
const ENSURE_HOOKS_TIMEOUT_MS = 2000;

export function useSplitPane() {
	const getActiveTab = useWorkspaceStore((s) => s.getActiveTab);
	const getActiveLayout = useWorkspaceStore((s) => s.getActiveLayout);
	const updateLayout = useWorkspaceStore((s) => s.updateLayout);
	const updateLayoutLocal = useWorkspaceStore((s) => s.updateLayoutLocal);
	const persistLayout = useWorkspaceStore((s) => s.persistLayout);
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);

	/** Split with an explicit choice (called by LaunchPicker handler in App.tsx). */
	const splitPaneWithChoice = useCallback(
		async (
			paneId: string,
			direction: "horizontal" | "vertical",
			agent?: CodingAgent,
		) => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			const newPaneId = generateId();
			const newTerminal: PaneNode = {
				type: "terminal",
				id: newPaneId,
				ptyId: "",
				agentId: agent?.id,
			};

			if (!findNode(layout, paneId)) return;

			// When launching an agent with hooks enabled, register its hooks
			// BEFORE the PTY spawns, so the config is in place by the time the
			// agent process reads it (covers a mid-session install). Awaited here
			// rather than alongside setPendingAgent so it can't race the pending-
			// command drain. Best-effort: a provisioning failure must not block
			// the launch. See ADR-0003 (Revisited).
			if (agent && useSettingsStore.getState().agentHooksEnabled) {
				try {
					// Cap the wait so slow disk I/O or provision-mutex contention
					// can't freeze the launch; the agent picks up hooks next run.
					await Promise.race([
						agentHooks.ensure(agent.id, true),
						new Promise<void>((resolve) => {
							setTimeout(resolve, ENSURE_HOOKS_TIMEOUT_MS);
						}),
					]);
				} catch (err) {
					console.error("[agentHooks] ensure failed:", err);
				}
			}

			const newLayout = wrapInSplit(layout, paneId, newTerminal, direction);
			await updateLayout(tab.id, newLayout);
			setFocusedPane(newPaneId);

			if (agent) {
				setPendingAgent(newPaneId, {
					command: [agent.command, ...(agent.args ?? [])].join(" "),
				});
			}
		},
		[getActiveTab, getActiveLayout, updateLayout, setFocusedPane],
	);

	/**
	 * Split with picker (called by keybindings/buttons).
	 * Opens LaunchPicker via a custom event so App.tsx can intercept it.
	 */
	const splitPaneWithPicker = useCallback(
		(paneId: string, direction: "horizontal" | "vertical") => {
			window.dispatchEvent(
				new CustomEvent("abundio:split-with-picker", {
					detail: { paneId, direction },
				}),
			);
		},
		[],
	);

	const closePaneNow = useCallback(
		(paneId: string) => closePaneNowById(paneId),
		[],
	);

	const closePane = useCallback((paneId: string, label?: string) => {
		requestPaneClose(paneId, label);
	}, []);

	/** Local-only ratio update (no DB persist) — call during drag. */
	const updateRatioLocal = useCallback(
		(splitNodeId: string, ratio: number) => {
			const tab = getActiveTab();
			const layout = getActiveLayout();
			if (!tab || !layout) return;

			const node = findNode(layout, splitNodeId);
			if (node?.type !== "split") return;

			const updated = replaceNode(layout, splitNodeId, { ...node, ratio });
			updateLayoutLocal(tab.id, updated);
		},
		[getActiveTab, getActiveLayout, updateLayoutLocal],
	);

	/** Persist current layout to DB — call on mouseup after drag. */
	const persistCurrentLayout = useCallback(async () => {
		const tab = getActiveTab();
		if (!tab) return;
		await persistLayout(tab.id);
	}, [getActiveTab, persistLayout]);

	/** Navigate focus to adjacent pane in the given direction. */
	// Directional move: focus the Pane bordering the focused one on that side,
	// by position in the layout. Does not wrap — at the Tab's edge it is a no-op.
	const navigatePane = useCallback(
		(direction: PaneDirection) => {
			const layout = getActiveLayout();
			if (!layout) return;
			const currentFocused = useWorkspaceStore.getState().focusedPaneId;
			if (!currentFocused || !findNode(layout, currentFocused)) {
				const first = cyclePane(layout, null, 1);
				if (first) setFocusedPane(first);
				return;
			}
			const target = neighbourInDirection(layout, currentFocused, direction);
			if (target) setFocusedPane(target);
		},
		[getActiveLayout, setFocusedPane],
	);

	// Pane cycle: next/previous Pane of any type in tree order, wrapping.
	const cycleFocusedPane = useCallback(
		(step: 1 | -1) => {
			const layout = getActiveLayout();
			if (!layout) return;
			const target = cyclePane(
				layout,
				useWorkspaceStore.getState().focusedPaneId,
				step,
			);
			if (target) setFocusedPane(target);
		},
		[getActiveLayout, setFocusedPane],
	);

	return {
		splitPaneWithChoice,
		splitPaneWithPicker,
		// Legacy alias used by tests / code that hasn't migrated
		splitPane: splitPaneWithPicker,
		closePane,
		closePaneNow,
		updateRatioLocal,
		persistCurrentLayout,
		navigatePane,
		cycleFocusedPane,
	};
}
