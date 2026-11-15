import { type ReactNode, useState } from "react";
import {
	type AgentMenuId,
	agentMenuEntries,
	restartProblemText,
} from "../../lib/agentMenu";
import { writeClipboardText } from "../../lib/clipboard";
import { switchToPane } from "../../lib/paneLocation";
import { restartAgentPane } from "../../lib/paneRestart";
import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import { requestPaneClose } from "../../stores/paneCloseConfirmStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { NameAgentDialog } from "../Terminal/NameAgentDialog";
import {
	type ContextMenuItem,
	PaneContextMenu,
} from "../Terminal/PaneContextMenu";

/** Open in Fleet Console: the console comes up with this Agent as the
 *  **Focused tile** (and in Spotlight, if one was on). */
function openInFleetConsole(paneId: string): void {
	const ui = useWindowUiStore.getState();
	ui.setFleetConsoleOpen(true);
	ui.setFocusedTile(paneId);
	if (ui.spotlightTileId) ui.setSpotlight(paneId);
}

/**
 * The **Agent menu** for one Agent, with the dialogs its entries open: the
 * Agents list's right-click menu, and the Orchestrator graph's (which puts
 * its own entries first, `extra`). `open(x, y)` shows it; render `element`.
 */
export function useAgentMenu({
	paneId,
	handle,
	label,
	extra = [],
}: {
	paneId: string;
	handle: string | undefined;
	/** How dialogs name the Agent: "Reviewer (api · Tab 1)". */
	label: string;
	extra?: ContextMenuItem[];
}): { open: (x: number, y: number) => void; element: ReactNode } {
	const flag = useAgentSignalsStore((s) => s.flags[paneId]);
	const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
	const [naming, setNaming] = useState(false);
	const [confirmRestart, setConfirmRestart] = useState(false);
	const [restartProblem, setRestartProblem] = useState<string | null>(null);

	const act: Record<AgentMenuId, () => void> = {
		"switch-to": () => switchToPane(paneId),
		"open-in-fleet": () => openInFleetConsole(paneId),
		rename: () => setNaming(true),
		"copy-handle": () => {
			if (handle) writeClipboardText(handle).catch(() => {});
		},
		"clear-flag": () => useAgentSignalsStore.getState().clearFlag(paneId),
		restart: () => setConfirmRestart(true),
		close: () => requestPaneClose(paneId, label),
	};
	const base: ContextMenuItem[] = agentMenuEntries({
		handle,
		flagged: !!flag,
	}).map((e) =>
		"separator" in e
			? { separator: true }
			: { label: e.label, onClick: act[e.id] },
	);
	const items: ContextMenuItem[] =
		extra.length > 0 ? [...extra, { separator: true }, ...base] : base;

	const element = (
		<>
			{menuAt && (
				<PaneContextMenu
					x={menuAt.x}
					y={menuAt.y}
					items={items}
					onClose={() => setMenuAt(null)}
				/>
			)}
			{naming && (
				<NameAgentDialog
					paneId={paneId}
					current={handle}
					onClose={() => setNaming(false)}
				/>
			)}
			{confirmRestart && (
				<ConfirmDialog
					title="Restart agent?"
					message={`Stop ${label} and start it again, resuming its session where it can.`}
					confirmLabel="Restart agent"
					confirmVariant="danger"
					onConfirm={() => {
						setConfirmRestart(false);
						void restartAgentPane(paneId).then((result) => {
							const problem = restartProblemText(result, label);
							if (problem) setRestartProblem(problem);
						});
					}}
					onCancel={() => setConfirmRestart(false)}
				/>
			)}
			{restartProblem && (
				<ConfirmDialog
					title="Agent not restarted"
					message={restartProblem}
					confirmLabel="OK"
					hideCancel
					onConfirm={() => setRestartProblem(null)}
					onCancel={() => setRestartProblem(null)}
				/>
			)}
		</>
	);
	return { open: (x, y) => setMenuAt({ x, y }), element };
}
