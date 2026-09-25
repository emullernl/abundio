import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetFocus = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ setFocus: mockSetFocus }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
	onAction: vi.fn(),
}));

vi.mock("../ipc", () => ({
	pty: {},
	tabs: { update: vi.fn(() => Promise.resolve()) },
	workspaces: { update: vi.fn(() => Promise.resolve()) },
}));

import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { publishFleetGrid } from "../fleetFocus";
import { handleNotificationClick, isPaneVisible } from "../notificationRouter";

beforeEach(() => {
	vi.clearAllMocks();
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws-1",
				name: "Test",
				rootFolder: "/test",
				agentPresetsJson: "{}",
				fileTabsJson: "[]",
				baseBranch: null,
				lastBranch: null,
				position: 0,
				profileId: "p-default",
				createdAt: 0,
				updatedAt: 0,
				worktreeSetupCommands: "",
				tabs: [
					{
						id: "tab-1",
						workspaceId: "ws-1",
						name: "Tab 1",
						layoutJson: JSON.stringify({
							type: "terminal",
							id: "pane-1",
							ptyId: "pty-1",
						}),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			},
		],
		activeWorkspaceId: "ws-1",
	});
	useWindowUiStore.setState({
		rightSidebarOpen: false,
		rightSidebarActiveTab: "explorer",
		fleetConsoleOpen: false,
		statisticsOverlayOpen: false,
		focusedTileId: null,
	});
	useWorkspaceStore.setState({ activeTabByWorkspace: { "ws-1": "tab-1" } });
	publishFleetGrid([], 1);
});

// While the Fleet Console is on screen its tiles are what is visible, and the
// Workspace view behind it is not (ADR-0040).
describe("Fleet Console visibility and clicks", () => {
	it("a pane in the active Tab is visible in the Workspace view", () => {
		expect(isPaneVisible("pane-1")).toBe(true);
	});

	it("in the console, only tiles count as visible", () => {
		useWindowUiStore.setState({ fleetConsoleOpen: true });
		expect(isPaneVisible("pane-1")).toBe(false);
		publishFleetGrid(["pane-1"], 1);
		expect(isPaneVisible("pane-1")).toBe(true);
	});

	it("a click on a tile's notification focuses the tile and stays in the console", () => {
		useWindowUiStore.setState({ fleetConsoleOpen: true });
		publishFleetGrid(["pane-1"], 1);
		handleNotificationClick({
			type: "pty",
			workspaceId: "ws-1",
			tabId: "tab-1",
			paneId: "pane-1",
		});
		const ui = useWindowUiStore.getState();
		expect(ui.fleetConsoleOpen).toBe(true);
		expect(ui.focusedTileId).toBe("pane-1");
	});

	it("a click for a pane that is not a tile leaves the console", () => {
		useWindowUiStore.setState({ fleetConsoleOpen: true });
		handleNotificationClick({
			type: "pty",
			workspaceId: "ws-1",
			tabId: "tab-1",
			paneId: "pane-1",
		});
		expect(useWindowUiStore.getState().fleetConsoleOpen).toBe(false);
	});
});

describe("handleNotificationClick", () => {
	it("focuses the window when extra is undefined", () => {
		handleNotificationClick(undefined);
		expect(mockSetFocus).toHaveBeenCalled();
	});

	it("focuses the window when extra has unknown type", () => {
		handleNotificationClick({ type: "unknown" });
		expect(mockSetFocus).toHaveBeenCalled();
	});

	it("navigates to pane for PTY notification", () => {
		const setActiveWorkspace = vi.spyOn(
			useWorkspaceStore.getState(),
			"beginWorkspaceSwitch",
		);
		const setActiveTab = vi.spyOn(useWorkspaceStore.getState(), "setActiveTab");
		const setFocusedPane = vi.spyOn(
			useWorkspaceStore.getState(),
			"setFocusedPane",
		);

		handleNotificationClick({
			type: "pty",
			paneId: "pane-1",
			workspaceId: "ws-1",
			tabId: "tab-1",
		});

		expect(mockSetFocus).toHaveBeenCalled();
		expect(setActiveWorkspace).toHaveBeenCalledWith("ws-1");
		expect(setActiveTab).toHaveBeenCalledWith("ws-1", "tab-1");
		expect(setFocusedPane).toHaveBeenCalledWith("pane-1");
	});

	it("opens right sidebar on the Git tab for PR notification", () => {
		const setActiveWorkspace = vi.spyOn(
			useWorkspaceStore.getState(),
			"beginWorkspaceSwitch",
		);

		handleNotificationClick({
			type: "pr",
			workspaceId: "ws-1",
		});

		expect(mockSetFocus).toHaveBeenCalled();
		expect(setActiveWorkspace).toHaveBeenCalledWith("ws-1");
		expect(useWindowUiStore.getState().rightSidebarOpen).toBe(true);
		expect(useWindowUiStore.getState().rightSidebarActiveTab).toBe("git");
	});

	it("only focuses window when PTY workspace no longer exists", () => {
		handleNotificationClick({
			type: "pty",
			paneId: "pane-1",
			workspaceId: "ws-gone",
			tabId: "tab-1",
		});

		expect(mockSetFocus).toHaveBeenCalled();
		// Should not throw, just gracefully no-op on navigation
	});

	it("only focuses window when PR workspace no longer exists", () => {
		handleNotificationClick({
			type: "pr",
			workspaceId: "ws-gone",
		});

		expect(mockSetFocus).toHaveBeenCalled();
		expect(useWindowUiStore.getState().rightSidebarOpen).toBe(false);
	});

	it("only focuses window when PTY extra has no workspaceId", () => {
		handleNotificationClick({ type: "pty" });

		expect(mockSetFocus).toHaveBeenCalled();
	});

	it("only focuses window when PR extra has no workspaceId", () => {
		handleNotificationClick({ type: "pr" });

		expect(mockSetFocus).toHaveBeenCalled();
		expect(useWindowUiStore.getState().rightSidebarOpen).toBe(false);
	});
});

describe("findPaneLocation", () => {
	it("finds workspace and tab containing a pane", async () => {
		const { findPaneLocation } = await import("../notificationRouter");
		const result = findPaneLocation("pane-1");
		expect(result).toEqual({ workspaceId: "ws-1", tabId: "tab-1" });
	});

	it("returns null when pane is not found", async () => {
		const { findPaneLocation } = await import("../notificationRouter");
		const result = findPaneLocation("pane-nonexistent");
		expect(result).toBeNull();
	});

	it("finds pane in nested split layout", async () => {
		useWorkspaceStore.setState({
			workspaces: [
				{
					id: "ws-2",
					name: "Split",
					rootFolder: "/split",
					agentPresetsJson: "{}",
					fileTabsJson: "[]",
					baseBranch: null,
					lastBranch: null,
					position: 0,
					profileId: "p-default",
					createdAt: 0,
					updatedAt: 0,
					worktreeSetupCommands: "",
					tabs: [
						{
							id: "tab-2",
							workspaceId: "ws-2",
							name: "Tab 2",
							layoutJson: JSON.stringify({
								type: "split",
								id: "split-1",
								direction: "horizontal",
								ratio: 0.5,
								first: {
									type: "terminal",
									id: "pane-a",
									ptyId: "pty-a",
								},
								second: {
									type: "terminal",
									id: "pane-b",
									ptyId: "pty-b",
								},
							}),
							position: 0,
							createdAt: 0,
							updatedAt: 0,
						},
					],
				},
			],
		});

		const { findPaneLocation } = await import("../notificationRouter");
		const result = findPaneLocation("pane-b");
		expect(result).toEqual({ workspaceId: "ws-2", tabId: "tab-2" });
	});
});
