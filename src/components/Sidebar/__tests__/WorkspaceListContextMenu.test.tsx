import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../../lib/ipc", () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
	worktrees: {
		dirty: vi.fn().mockResolvedValue(false),
		add: vi.fn(),
		remove: vi.fn(),
	},
	git: { workspacesSummary: vi.fn().mockResolvedValue([]) },
	workspaces: { update: vi.fn().mockResolvedValue(undefined) },
}));

import type { WorkspaceWithTabs } from "../../../lib/types";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { WorkspaceList } from "../WorkspaceList";

// WorkspaceItem measures its own height through a ResizeObserver (it publishes
// `--workspace-item-height` for the narrow sidebar's strips); jsdom has none.
class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver ??=
	NoopResizeObserver as unknown as typeof ResizeObserver;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function workspace(id: string, name: string): WorkspaceWithTabs {
	return {
		id,
		name,
		rootFolder: `/repos/${name}`,
		agentPresetsJson: "{}",
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

const OPENED = workspace("ws-opened", "abundio");
const DORMANT = workspace("ws-dormant", "other-repo");

describe("WorkspaceList — context menu Open / Close", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const beginWorkspaceSwitch = vi.fn();
	const closeWorkspace = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		beginWorkspaceSwitch.mockClear();
		closeWorkspace.mockClear();
		useWorkspaceStore.setState({
			workspaces: [
				{ ...OPENED, position: 0 },
				{ ...DORMANT, position: 1 },
			],
			activeWorkspaceId: OPENED.id,
			switchingWorkspaceId: null,
			beginWorkspaceSwitch,
			closeWorkspace,
		});
		usePtyActivityStore.setState({
			activities: {},
			panePtyMap: {},
			openedWorkspaceIds: new Set([OPENED.id]),
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(<WorkspaceList />);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function openMenuOn(name: string) {
		const row = [...container.querySelectorAll("span")]
			.find((el) => el.textContent === name)
			?.closest('[role="button"]');
		expect(row).toBeTruthy();
		act(() => {
			row?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
			);
		});
	}

	const menuLabels = () =>
		[...document.body.querySelectorAll("button")].map(
			(b) => b.textContent ?? "",
		);

	function clickMenu(label: string) {
		const button = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent === label,
		);
		expect(button).toBeTruthy();
		act(() => {
			button?.click();
		});
	}

	it("offers Open Workspace on a dormant workspace, and opens it", () => {
		openMenuOn("other-repo");
		expect(menuLabels()).toContain("Open Workspace");
		expect(menuLabels()).not.toContain("Close Workspace");
		clickMenu("Open Workspace");
		expect(beginWorkspaceSwitch).toHaveBeenCalledWith(DORMANT.id);
		expect(closeWorkspace).not.toHaveBeenCalled();
	});

	it("offers Close Workspace on an Opened workspace, and closes it", () => {
		openMenuOn("abundio");
		expect(menuLabels()).toContain("Close Workspace");
		expect(menuLabels()).not.toContain("Open Workspace");
		clickMenu("Close Workspace");
		expect(closeWorkspace).toHaveBeenCalledWith(OPENED.id);
		expect(beginWorkspaceSwitch).not.toHaveBeenCalled();
	});
});
