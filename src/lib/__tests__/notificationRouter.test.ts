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

import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { handleNotificationClick } from "../notificationRouter";

beforeEach(() => {
	vi.clearAllMocks();
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws-1",
				name: "Test",
				rootFolder: "/test",
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
						sortOrder: 0,
					},
				],
				sortOrder: 0,
				baseBranch: null,
			},
		],
		activeWorkspaceId: "ws-1",
	});
	useGitChangesStore.setState({ panelOpen: false });
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
			"setActiveWorkspace",
		);
		const setActiveTab = vi.spyOn(useWorkspaceStore.getState(), "setActiveTab");
		const setFocusedPane = vi.spyOn(
			useWorkspaceStore.getState(),
			"setFocusedPane",
		);
		const setActiveView = vi.spyOn(
			useWorkspaceStore.getState(),
			"setActiveView",
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
		expect(setActiveView).toHaveBeenCalledWith("ws-1", "terminal");
	});

	it("opens git panel for PR notification", () => {
		const setActiveWorkspace = vi.spyOn(
			useWorkspaceStore.getState(),
			"setActiveWorkspace",
		);

		handleNotificationClick({
			type: "pr",
			workspaceId: "ws-1",
		});

		expect(mockSetFocus).toHaveBeenCalled();
		expect(setActiveWorkspace).toHaveBeenCalledWith("ws-1");
		expect(useGitChangesStore.getState().panelOpen).toBe(true);
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
		expect(useGitChangesStore.getState().panelOpen).toBe(false);
	});

	it("only focuses window when PTY extra has no workspaceId", () => {
		handleNotificationClick({ type: "pty" });

		expect(mockSetFocus).toHaveBeenCalled();
	});

	it("only focuses window when PR extra has no workspaceId", () => {
		handleNotificationClick({ type: "pr" });

		expect(mockSetFocus).toHaveBeenCalled();
		expect(useGitChangesStore.getState().panelOpen).toBe(false);
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
							sortOrder: 0,
						},
					],
					sortOrder: 0,
					baseBranch: null,
				},
			],
		});

		const { findPaneLocation } = await import("../notificationRouter");
		const result = findPaneLocation("pane-b");
		expect(result).toEqual({ workspaceId: "ws-2", tabId: "tab-2" });
	});
});
