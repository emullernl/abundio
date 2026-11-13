import { getTerminal } from "../lib/terminalManager";
import {
	computePtyDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";

/**
 * The **status icon** state of one pane's PTY. Shared by the pane title bar
 * and the **Agent row**, so both always show the same icon.
 */
export function usePaneStatus(paneId: string): DotStatus {
	const panePtyId = usePtyActivityStore((s) => s.panePtyMap[paneId] ?? "");
	const ptyId = getTerminal(paneId)?.ptyId || panePtyId;
	return usePtyActivityStore((s) => computePtyDotStatus(ptyId, s.activities));
}
