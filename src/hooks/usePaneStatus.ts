import { getTerminal } from "../lib/terminalManager";
import { useAgentSignalsStore } from "../stores/agentSignalsStore";
import {
	computePtyDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";

/**
 * The **status icon** state of one pane's PTY. Shared by the pane title bar
 * and the **Agent row**, so both always show the same icon. An open
 * **Question card** shows as Waiting: derived here, never written to the
 * status machine, so the Agent's own status changes cannot clear it
 * (ADR-0056).
 */
export function usePaneStatus(paneId: string): DotStatus {
	const panePtyId = usePtyActivityStore((s) => s.panePtyMap[paneId] ?? "");
	const ptyId = getTerminal(paneId)?.ptyId || panePtyId;
	const asking = useAgentSignalsStore((s) => !!s.questions[paneId]);
	const status = usePtyActivityStore((s) =>
		computePtyDotStatus(ptyId, s.activities),
	);
	return asking ? "skyblue" : status;
}
