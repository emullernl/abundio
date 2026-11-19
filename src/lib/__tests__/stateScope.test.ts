import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
	onAction: vi.fn(),
}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { PTY_ACTIVITY_STATE_SCOPE, WORKSPACE_STATE_SCOPE } from "../stateScope";

function dataKeys(state: object): string[] {
	return Object.entries(state)
		.filter(([, v]) => typeof v !== "function")
		.map(([k]) => k)
		.sort();
}

describe("state scope", () => {
	it("labels every data field of the Workspace store", () => {
		expect(dataKeys(useWorkspaceStore.getState())).toEqual(
			Object.keys(WORKSPACE_STATE_SCOPE).sort(),
		);
	});

	it("labels every data field of the PTY activity store", () => {
		expect(dataKeys(usePtyActivityStore.getState())).toEqual(
			Object.keys(PTY_ACTIVITY_STATE_SCOPE).sort(),
		);
	});
});
