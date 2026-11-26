import { useAgentSignalsStore } from "../../stores/agentSignalsStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { handlePrefixFor } from "../handlePrefix";
import type { PaneFacts, PaneFactsReport } from "../ipc";
import { isRustStatusAuthority } from "../statusSync";
import type { CodingAgent, WorkspaceWithTabs } from "../types";
import {
	onShellIntegrationSeen,
	shellIntegrationSeenPanes,
} from "./integrationSeen";
import { workspacePanes } from "./resolveTarget";

/**
 * Tells Rust what this Window knows about its panes that Rust does not see
 * yet (`pane_facts.rs`, docs/plans/remote-hosts.md phase 5), so Agent
 * control can describe them there: the terminal title, the live folder, the
 * running command, the Agent detected, the **Progress line**. Their sources
 * move into Rust with the server (phase 6), and this goes away.
 */

interface Sources {
	workspaces: readonly WorkspaceWithTabs[];
	panePtyMap: Readonly<Record<string, string>>;
	titles: Readonly<Record<string, string>>;
	cwds: Readonly<Record<string, string>>;
	runningCommands: Readonly<Record<string, string>>;
	detectedAgentIds: Readonly<Record<string, string>>;
	progress: Readonly<Record<string, string>>;
	/** Panes whose shell integration has reported in. */
	integrationSeen: ReadonlySet<string>;
	/** The user's Agents, for a custom Agent's **Handle prefix**. */
	agents: readonly Pick<CodingAgent, "id" | "name">[];
}

/** Every terminal pane's facts. Pure. */
export function collectPaneFacts(src: Sources): Map<string, PaneFacts> {
	const out = new Map<string, PaneFacts>();
	for (const ws of src.workspaces) {
		for (const { node } of workspacePanes(ws.tabs)) {
			const ptyId = src.panePtyMap[node.id] || node.ptyId;
			const at = (m: Readonly<Record<string, string>>) =>
				(ptyId && m[ptyId]) || null;
			out.set(node.id, {
				title: src.titles[node.id] || null,
				cwd: at(src.cwds),
				command: at(src.runningCommands),
				detectedAgentId: at(src.detectedAgentIds),
				progress: src.progress[node.id] ?? null,
				shellIntegrationSeen: src.integrationSeen.has(node.id),
				handlePrefix: handlePrefixFor(
					node.agentId ?? at(src.detectedAgentIds),
					src.agents,
				),
			});
		}
	}
	return out;
}

function same(a: PaneFacts, b: PaneFacts): boolean {
	return (
		a.title === b.title &&
		a.cwd === b.cwd &&
		a.command === b.command &&
		a.detectedAgentId === b.detectedAgentId &&
		a.progress === b.progress &&
		a.shellIntegrationSeen === b.shellIntegrationSeen &&
		a.handlePrefix === b.handlePrefix
	);
}

/** What changed from `before` to `after`: new or changed panes, and gone
 *  ones (`facts: null`). Pure. */
export function diffPaneFacts(
	before: ReadonlyMap<string, PaneFacts>,
	after: ReadonlyMap<string, PaneFacts>,
): PaneFactsReport[] {
	const out: PaneFactsReport[] = [];
	for (const [paneId, facts] of after) {
		const was = before.get(paneId);
		if (!was || !same(was, facts)) out.push({ paneId, facts });
	}
	for (const paneId of before.keys()) {
		if (!after.has(paneId)) out.push({ paneId, facts: null });
	}
	return out;
}

/** Report while the app runs (not in tests or the browser demo). */
export function startPaneFactsSync(): () => void {
	if (!isRustStatusAuthority()) return () => {};
	let sent = new Map<string, PaneFacts>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	const flush = () => {
		timer = null;
		const act = usePtyActivityStore.getState();
		const now = collectPaneFacts({
			workspaces: useWorkspaceStore.getState().workspaces,
			panePtyMap: act.panePtyMap,
			titles: act.titles,
			cwds: act.cwds,
			runningCommands: act.runningCommands,
			detectedAgentIds: act.detectedAgentIds,
			progress: useAgentSignalsStore.getState().progress,
			integrationSeen: shellIntegrationSeenPanes(),
			agents: useSettingsStore.getState().agents,
		});
		const reports = diffPaneFacts(sent, now);
		sent = now;
		if (reports.length === 0) return;
		import("../ipc")
			.then(({ agentControl }) => agentControl.reportPaneFacts(reports))
			.catch((e) => console.warn("[agent control] facts not sent", e));
	};
	// A burst of store changes (a title per keystroke) becomes one report.
	const schedule = () => {
		if (timer === null) timer = setTimeout(flush, 50);
	};
	const unsubs = [
		usePtyActivityStore.subscribe(schedule),
		useWorkspaceStore.subscribe(schedule),
		useAgentSignalsStore.subscribe(schedule),
		// Only the Agent list matters here (a custom Agent's prefix).
		useSettingsStore.subscribe((s, prev) => {
			if (s.agents !== prev.agents) schedule();
		}),
	];
	onShellIntegrationSeen(schedule);
	schedule();
	return () => {
		onShellIntegrationSeen(null);
		for (const u of unsubs) u();
		if (timer !== null) clearTimeout(timer);
	};
}
