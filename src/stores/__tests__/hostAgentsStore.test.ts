import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import {
	agentsForWorkspace,
	agentsFromHostSettings,
	useHostAgentsStore,
} from "../hostAgentsStore";
import { useProfileStore } from "../profileStore";
import { useSettingsStore } from "../settingsStore";
import { useWorkspaceStore } from "../workspaceStore";

const ws = (id: string, hostId?: string) =>
	({
		id,
		tabs: [],
		...(hostId ? { joined: { hostId } } : {}),
	}) as unknown as WorkspaceWithTabs;

const box = agentsFromHostSettings({
	agentSwitches: { opencode: true },
	customAgents: [
		{
			id: "mine",
			name: "Mine",
			command: "my-agent",
			builtin: false,
			enabled: true,
		},
	],
	agentHooksEnabled: true,
	agentSkillEnabled: true,
	shellPath: null,
	scrollback: null,
});

describe("hostAgentsStore (phase 10d-2, ADR-0064)", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [ws("local"), ws("joined", "box")],
		});
		useHostAgentsStore.setState({ byHost: { box } });
		useProfileStore.setState({ remote: null });
	});

	it("builds a Host's list from its switches and custom Agents", () => {
		const on = box.filter((a) => a.enabled).map((a) => a.id);
		expect(on).toEqual(["opencode", "mine"]);
		expect(box.find((a) => a.id === "claude")?.enabled).toBe(false);
	});

	it("gives each Workspace its own Host's list", () => {
		expect(agentsForWorkspace("joined")).toBe(box);
		expect(agentsForWorkspace("local")).toBe(
			useSettingsStore.getState().agents,
		);
	});

	it("gives every Workspace of a remote Window its Host's list", () => {
		useProfileStore.setState({
			remote: {
				hostId: "box",
				hostName: "Box",
				profileId: "p",
				profileName: "P",
			},
		});
		expect(agentsForWorkspace("local")).toBe(box);
	});
});
