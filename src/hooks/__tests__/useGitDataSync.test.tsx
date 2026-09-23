import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useGitDataSync } from "../useGitDataSync";

vi.mock("../../lib/ipc", () => ({
	git: {
		schedulerStart: vi.fn().mockResolvedValue(undefined),
		schedulerStop: vi.fn().mockResolvedValue(undefined),
		onGitState: vi.fn().mockResolvedValue(() => {}),
	},
	pr: {
		snapshot: vi.fn().mockResolvedValue(null),
		onPrState: vi.fn().mockResolvedValue(() => {}),
		onUnreadCleared: vi.fn().mockResolvedValue(() => {}),
		onPrChanges: vi.fn().mockResolvedValue(() => {}),
	},
	workspaces: { update: vi.fn().mockResolvedValue(undefined) },
	worktrees: {},
	pty: {},
	tabs: {},
	listen: vi.fn().mockResolvedValue(() => {}),
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		agentPresetsJson: "[]",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [],
	};
}

function Harness() {
	useGitDataSync();
	return null;
}

const live = {
	dirty: true,
	breakdown: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
};

describe("useGitDataSync — live dirtiness lifecycle", () => {
	let root: Root;

	beforeEach(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: partial store
		useWorkspaceStore.setState({ workspaces: [ws("a"), ws("b")] } as any);
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["a", "b"]) });
		useWorkspaceGitStore.setState({ uncommittedById: { a: live, b: live } });
		root = createRoot(document.createElement("div"));
		await act(async () => root.render(<Harness />));
	});

	it("ends the live value when a workspace stops being Opened", async () => {
		await act(async () => {
			usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["b"]) });
		});
		// Keeps the last answer, but lets the batched summary refresh it again.
		expect(useWorkspaceGitStore.getState().uncommittedById.a).toEqual({
			dirty: true,
			breakdown: null,
		});
		expect(useWorkspaceGitStore.getState().uncommittedById.b).toBe(live);
		await act(async () => root.unmount());
	});

	it("ends every live value on unmount, so none is stranded as unrefreshable", async () => {
		// A live entry outranks any batched summary, so one left behind here
		// could never be refreshed — the store outlives this hook.
		await act(async () => root.unmount());
		expect(useWorkspaceGitStore.getState().uncommittedById).toEqual({
			a: { dirty: true, breakdown: null },
			b: { dirty: true, breakdown: null },
		});
	});
});
