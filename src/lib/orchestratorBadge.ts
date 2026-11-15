/**
 * The **Orchestrator badge** (GLOSSARY.md): the **Agent rollup** of the
 * Orchestrator workspace — the Orchestrator and its helpers — drawn on the
 * Overview bar's Orchestrator button, and the pane that wants the user most
 * when the view opens. Pure.
 */

import {
	computePtyDotStatus,
	type DotStatus,
	dotStatusLabel,
	type PtyActivityEntry,
	type StatusCounts,
} from "../stores/ptyActivityStore";
import { orchestratorPane } from "./orchestrator";
import { collectTerminals, parseTabLayout } from "./paneTree";
import type { Tab } from "./types";

/** One agent-mode pane of the Orchestrator workspace. */
export interface BadgeAgent {
	paneId: string;
	tabId: string;
	status: DotStatus;
	isOrchestrator: boolean;
}

export interface OrchestratorBadge {
	/** The rollup: the most urgent state among them. */
	status: DotStatus;
	/** The tooltip, one line each: the Orchestrator, then its helpers. */
	tooltip: string;
	/** The pane to focus when the view opens: the one that wants the user
	 *  most (Waiting, then Ready; the Orchestrator first on a tie), or `null`
	 *  when nobody is Waiting or Ready. */
	focus: { paneId: string; tabId: string } | null;
}

/** Most urgent first: the Agent rollup's order. */
const ORDER: DotStatus[] = ["red", "skyblue", "purple", "amber", "green"];
const COUNT_KEY: Partial<Record<DotStatus, keyof StatusCounts>> = {
	red: "error",
	skyblue: "waiting",
	purple: "ready",
	amber: "working",
	green: "idle",
};

/** The agent-mode panes of the Orchestrator workspace, Tab then pane order. */
export function badgeAgents(
	tabs: readonly Tab[],
	panePtyMap: Record<string, string>,
	activities: Record<string, PtyActivityEntry>,
): BadgeAgent[] {
	const own = orchestratorPane(tabs)?.paneId ?? null;
	const out: BadgeAgent[] = [];
	for (const tab of [...tabs].sort((a, b) => a.position - b.position)) {
		const layout = parseTabLayout(tab.layoutJson);
		if (!layout) continue;
		for (const t of collectTerminals(layout)) {
			const ptyId = panePtyMap[t.id] || t.ptyId;
			if (!ptyId || activities[ptyId]?.detectionMode !== "agent") continue;
			out.push({
				paneId: t.id,
				tabId: tab.id,
				status: computePtyDotStatus(ptyId, activities),
				isOrchestrator: t.id === own,
			});
		}
	}
	return out;
}

/** The badge for these agents, or `null` when none runs (no badge). */
export function orchestratorBadge(
	agents: readonly BadgeAgent[],
): OrchestratorBadge | null {
	if (agents.length === 0) return null;
	const rank = (s: DotStatus) => {
		const i = ORDER.indexOf(s);
		return i < 0 ? ORDER.length : i;
	};
	const status = agents.reduce<DotStatus>(
		(best, a) => (rank(a.status) < rank(best) ? a.status : best),
		"green",
	);

	const own = agents.find((a) => a.isOrchestrator);
	const helpers = agents.filter((a) => !a.isOrchestrator);
	const lines = [
		`Orchestrator · ${own ? dotStatusLabel(own.status) : "Not running"}`,
	];
	if (helpers.length > 0) {
		const counts: Partial<Record<keyof StatusCounts, number>> = {};
		for (const h of helpers) {
			const key = COUNT_KEY[h.status];
			if (key) counts[key] = (counts[key] ?? 0) + 1;
		}
		const parts = ORDER.flatMap((s) => {
			const key = COUNT_KEY[s];
			const n = key ? counts[key] : 0;
			return n ? [`${n} ${dotStatusLabel(s)}`] : [];
		});
		lines.push(`Helpers · ${parts.join(", ")}`);
	}

	// Waiting before Ready; within one state the Orchestrator, then the
	// helpers in Tab and pane order.
	const wanting = ["skyblue", "purple"] as DotStatus[];
	let focus: OrchestratorBadge["focus"] = null;
	for (const s of wanting) {
		const hit =
			(own?.status === s ? own : undefined) ??
			helpers.find((h) => h.status === s);
		if (hit) {
			focus = { paneId: hit.paneId, tabId: hit.tabId };
			break;
		}
	}
	return { status, tooltip: lines.join("\n"), focus };
}
