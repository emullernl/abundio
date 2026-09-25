import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceWithTabs } from "../../../lib/types";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { openInBackground } from "../WorkspacePicker";

function ws(id: string): WorkspaceWithTabs {
	const layout = {
		type: "split",
		id: "s",
		direction: "vertical",
		ratio: 0.5,
		first: {
			type: "terminal",
			id: `${id}-agent`,
			ptyId: "",
			agentId: "claude",
		},
		second: { type: "terminal", id: `${id}-shell`, ptyId: "" },
	};
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		tabs: [
			{
				id: `${id}-t`,
				workspaceId: id,
				name: "Tab",
				layoutJson: JSON.stringify(layout),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} as unknown as WorkspaceWithTabs;
}

// Opening a Workspace from the Fleet Console adds its Agents — see the
// Fleet Console entry in CONTEXT.md.
describe("WorkspacePicker helpers", () => {
	beforeEach(() => {
		useWorkspaceStore.setState({
			workspaces: [ws("a")],
			activeWorkspaceId: null,
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
		useWindowUiStore.setState({ pendingTiles: {}, focusedTileId: null });
	});

	it("opens in the background and shows the remembered Agents as tiles", () => {
		openInBackground("a");
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("a")).toBe(
			true,
		);
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
		expect(Object.keys(useWindowUiStore.getState().pendingTiles)).toEqual([
			"a-agent",
		]);
		// Opening does not move the console's focus.
		expect(useWindowUiStore.getState().focusedTileId).toBeNull();
	});

	it("does nothing for a Workspace that is already open", () => {
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["a"]) });
		openInBackground("a");
		expect(useWindowUiStore.getState().pendingTiles).toEqual({});
	});
});
