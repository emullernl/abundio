import { useSessionStore } from "../../stores/sessionStore";
import type { PaneNode } from "../../lib/types";
import { TerminalInstance } from "./TerminalInstance";

interface TerminalInfo {
	paneId: string;
	ptyId: string;
}

function collectTerminals(node: PaneNode): TerminalInfo[] {
	if (node.type === "terminal") return [{ paneId: node.id, ptyId: node.ptyId }];
	return [...collectTerminals(node.first), ...collectTerminals(node.second)];
}

export function TerminalPool() {
	const sessions = useSessionStore((s) => s.sessions);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);

	const session = sessions.find((s) => s.id === activeSessionId);
	if (!session) return null;

	// Collect terminals from ALL tabs so they survive tab switches
	const terminals: (TerminalInfo & { cwd: string })[] = [];
	for (const tab of session.tabs) {
		try {
			const layout = JSON.parse(tab.layoutJson) as PaneNode;
			for (const t of collectTerminals(layout)) {
				terminals.push({ ...t, cwd: session.rootFolder });
			}
		} catch {
			// Skip unparseable layouts
		}
	}

	return (
		<div style={{ position: "fixed", left: "-9999px", visibility: "hidden", width: 0, height: 0 }}>
			{terminals.map((t) => (
				<TerminalInstance
					key={t.paneId}
					paneId={t.paneId}
					ptyId={t.ptyId}
					cwd={t.cwd}
				/>
			))}
		</div>
	);
}
