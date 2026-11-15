import { describe, expect, it } from "vitest";
import type { PtyActivityEntry } from "../../stores/ptyActivityStore";
import {
	type BadgeAgent,
	badgeAgents,
	orchestratorBadge,
} from "../orchestratorBadge";
import type { PaneNode, Tab } from "../types";

const agent = (
	paneId: string,
	status: BadgeAgent["status"],
	isOrchestrator = false,
	tabId = "t1",
): BadgeAgent => ({ paneId, tabId, status, isOrchestrator });

describe("orchestratorBadge", () => {
	it("is absent while no Agent runs there", () => {
		expect(orchestratorBadge([])).toBeNull();
	});

	it("rolls the Orchestrator and its helpers up, most urgent winning", () => {
		const badge = orchestratorBadge([
			agent("orch", "green", true),
			agent("h1", "amber"),
			agent("h2", "skyblue"),
		]);
		expect(badge?.status).toBe("skyblue");
		expect(badge?.tooltip).toBe(
			"Orchestrator · Idle\nHelpers · 1 Waiting, 1 Working",
		);
	});

	it("leaves the helpers line out when there are none", () => {
		expect(orchestratorBadge([agent("orch", "amber", true)])?.tooltip).toBe(
			"Orchestrator · Working",
		);
	});

	it("still shows a helper after the Orchestrator has exited", () => {
		const badge = orchestratorBadge([agent("h1", "purple")]);
		expect(badge?.status).toBe("purple");
		expect(badge?.tooltip).toBe(
			"Orchestrator · Not running\nHelpers · 1 Ready",
		);
	});

	it("focuses the pane that wants the user most", () => {
		// Nobody Waiting or Ready: focus stays where it was.
		expect(
			orchestratorBadge([agent("orch", "amber", true), agent("h1", "red")])
				?.focus,
		).toBeNull();
		// Waiting beats Ready, wherever it is.
		expect(
			orchestratorBadge([
				agent("orch", "purple", true),
				agent("h1", "skyblue", false, "t2"),
			])?.focus,
		).toEqual({ paneId: "h1", tabId: "t2" });
		// A tie goes to the Orchestrator, then the first helper.
		expect(
			orchestratorBadge([
				agent("h1", "skyblue"),
				agent("orch", "skyblue", true),
			])?.focus?.paneId,
		).toBe("orch");
		expect(
			orchestratorBadge([agent("h1", "purple"), agent("h2", "purple")])?.focus
				?.paneId,
		).toBe("h1");
	});
});

describe("badgeAgents", () => {
	const term = (id: string, ptyId: string, handle?: string): PaneNode => ({
		type: "terminal",
		id,
		ptyId,
		...(handle ? { agentHandle: handle } : {}),
	});
	const tab = (id: string, position: number, layout: PaneNode): Tab => ({
		id,
		workspaceId: "orch-ws",
		name: id,
		layoutJson: JSON.stringify(layout),
		position,
		createdAt: 0,
		updatedAt: 0,
	});
	const entry = (
		state: PtyActivityEntry["state"],
		mode: PtyActivityEntry["detectionMode"] = "agent",
	) => ({ state, detectionMode: mode }) as PtyActivityEntry;

	it("takes agent-mode panes only, live PTY first, and marks the Orchestrator", () => {
		const tabs = [
			tab("t2", 1, term("h1", "p-h1")),
			tab("t1", 0, {
				type: "split",
				id: "s",
				direction: "horizontal",
				ratio: 0.5,
				first: term("orch", "stale", "Orchestrator"),
				second: term("sh", "p-sh"),
			}),
		];
		const agents = badgeAgents(
			tabs,
			{ orch: "p-orch" },
			{
				"p-orch": entry("waiting"),
				"p-sh": entry("active", "shell"),
				"p-h1": entry("active"),
			},
		);
		expect(agents).toEqual([
			{ paneId: "orch", tabId: "t1", status: "skyblue", isOrchestrator: true },
			{ paneId: "h1", tabId: "t2", status: "amber", isOrchestrator: false },
		]);
	});
});
