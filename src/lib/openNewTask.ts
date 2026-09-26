import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { fleetConsoleShowing } from "./fleetFocus";

/**
 * Open the **New task** dialog. Every entry point comes through here so they
 * agree on the target: an explicit Workspace (a sidebar row), else the Focused
 * tile's Workspace in the Fleet Console, else the Active workspace.
 */
export function openNewTask(opts?: {
	workspaceId?: string;
	onBack?: () => void;
}): void {
	const fromFleet = fleetConsoleShowing();
	const ws = useWorkspaceStore.getState();
	let workspaceId = opts?.workspaceId ?? null;
	if (!workspaceId && fromFleet) {
		const tile = useWindowUiStore.getState().focusedTileId;
		workspaceId = tile ? (ws.findWorkspaceForPane(tile)?.id ?? null) : null;
	}
	workspaceId ??= ws.activeWorkspaceId;
	useWindowUiStore
		.getState()
		.requestNewTask({ workspaceId, fromFleet, onBack: opts?.onBack });
}
