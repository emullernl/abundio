import { useEffect, useMemo, useState } from "react";
import type { PaneNode } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";
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
	const [loadAll, setLoadAll] = useState(false);

	// Defer non-active session PTY spawning by 2s so the active session is responsive first.
	useEffect(() => {
		if (!activeSessionId) return;
		const timer = setTimeout(() => setLoadAll(true), 2000);
		return () => clearTimeout(timer);
	}, [activeSessionId]);

	// Collect terminals from ALL sessions so they survive session switches.
	// App.tsx already keeps all sessions' SplitContainer trees mounted (display:none),
	// so the slot/target side survives; this makes the instance side match.
	const terminals = useMemo(() => {
		const result: (TerminalInfo & { cwd: string })[] = [];
		for (const session of sessions) {
			if (!loadAll && session.id !== activeSessionId) continue;
			for (const tab of session.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					for (const t of collectTerminals(layout)) {
						result.push({ ...t, cwd: session.rootFolder });
					}
				} catch {
					// Skip unparseable layouts
				}
			}
		}
		return result;
	}, [sessions, activeSessionId, loadAll]);

	return (
		<div
			style={{
				position: "fixed",
				left: "-9999px",
				visibility: "hidden",
				width: 0,
				height: 0,
			}}
		>
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
