import { useEffect, useMemo, useState } from "react";
import type { PaneNode } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspaceStore";
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
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const [loadAll, setLoadAll] = useState(false);

	// Defer non-active workspace PTY spawning by 2s so the active workspace is responsive first.
	useEffect(() => {
		if (!activeWorkspaceId) return;
		const timer = setTimeout(() => setLoadAll(true), 2000);
		return () => clearTimeout(timer);
	}, [activeWorkspaceId]);

	// Collect terminals from ALL workspaces so they survive workspace switches.
	// App.tsx already keeps all workspaces' SplitContainer trees mounted (display:none),
	// so the slot/target side survives; this makes the instance side match.
	const terminals = useMemo(() => {
		const result: (TerminalInfo & { cwd: string })[] = [];
		for (const workspace of workspaces) {
			if (!loadAll && workspace.id !== activeWorkspaceId) continue;
			for (const tab of workspace.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					for (const t of collectTerminals(layout)) {
						result.push({ ...t, cwd: workspace.rootFolder });
					}
				} catch {
					// Skip unparseable layouts
				}
			}
		}
		return result;
	}, [workspaces, activeWorkspaceId, loadAll]);

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
