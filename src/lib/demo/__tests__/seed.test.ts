import { describe, expect, it } from "vitest";
import {
	computeWorkspaceDotStatus,
	usePtyActivityStore,
} from "../../../stores/ptyActivityStore";
import type { PaneNode } from "../../types";
import { agentPanes, panesByWorkspace, workspaces } from "../fixtures";
import { seedPaneActivity } from "../seed";

function layoutsFor(wsId: string): PaneNode[] {
	const ws = workspaces.find((w) => w.id === wsId);
	if (!ws) throw new Error(`missing ${wsId}`);
	return ws.tabs.map((t) => JSON.parse(t.layoutJson) as PaneNode);
}

/** Mirrors what useDemoBootstrap does for an opened workspace. */
function preSeed(wsId: string): void {
	usePtyActivityStore.getState().markWorkspaceOpened(wsId);
	for (const paneId of panesByWorkspace[wsId] ?? []) {
		seedPaneActivity(`demo-${paneId}`, paneId, agentPanes[paneId]);
	}
}

function dot(wsId: string): string {
	const s = usePtyActivityStore.getState();
	return computeWorkspaceDotStatus(
		wsId,
		layoutsFor(wsId),
		s.activities,
		s.openedWorkspaceIds,
		s.panePtyMap,
	);
}

describe("demo status pre-seeding (visible without spawning a PTY)", () => {
	it("colours an opened workspace's dot from synthetic ptyIds alone", () => {
		preSeed("ws-acme"); // claude active → amber
		preSeed("ws-infra"); // codex error → red
		preSeed("ws-payments"); // copilot waiting → skyblue

		expect(dot("ws-acme")).toBe("amber");
		expect(dot("ws-infra")).toBe("red");
		expect(dot("ws-payments")).toBe("skyblue");
	});

	it("leaves an unopened workspace grey", () => {
		expect(dot("ws-cli")).toBe("grey");
	});
});
