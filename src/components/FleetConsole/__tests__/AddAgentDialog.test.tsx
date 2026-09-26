import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { WorkspaceWithTabs } from "../../../lib/types";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { AddAgentDialog, useRelaunchRows } from "../AddAgentDialog";

/** The dialog as the Console mounts it, with the rows it computes. */
function Harness(props: {
	initialStep?: "choose" | "relaunch";
	onClose: () => void;
}) {
	return (
		<AddAgentDialog rows={useRelaunchRows()} onReopen={() => {}} {...props} />
	);
}

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string, agentId?: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		position: 0,
		lastBranch: null,
		tabs: [
			{
				id: `${id}-t`,
				workspaceId: id,
				name: "Tab",
				layoutJson: JSON.stringify({
					type: "terminal",
					id: `${id}-p`,
					ptyId: "",
					...(agentId ? { agentId } : {}),
				}),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} as unknown as WorkspaceWithTabs;
}

// See the Add agent and Relaunch entries in CONTEXT.md.
describe("AddAgentDialog", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const onClose = vi.fn();

	const dialogLabel = () =>
		document.querySelector('[role="dialog"]')?.getAttribute("aria-label");
	const render = (initialStep?: "choose" | "relaunch") =>
		act(() =>
			root.render(<Harness initialStep={initialStep} onClose={onClose} />),
		);

	beforeEach(() => {
		onClose.mockReset();
		// jsdom has no layout, so no scrollIntoView.
		Element.prototype.scrollIntoView = vi.fn();
		const claude = useSettingsStore
			.getState()
			.agents.find((a) => a.id === "claude");
		expect(claude).toBeDefined();
		useWorkspaceStore.setState({
			workspaces: [ws("api", "claude"), ws("plain")],
			activeWorkspaceId: null,
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
		useWindowUiStore.setState({ pendingTiles: {} });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("offers the choice while a Workspace is Dormant", () => {
		render();
		expect(dialogLabel()).toBe("Add agent");
		expect(document.body.textContent).toContain(
			"Relaunch from a dormant workspace",
		);
	});

	it("still offers New agent and New task when nothing is Dormant", () => {
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["api"]) });
		render();
		expect(dialogLabel()).toBe("Add agent");
		expect(document.body.textContent).toContain("New task");
		expect(document.body.textContent).not.toContain(
			"Relaunch from a dormant workspace",
		);
	});

	it("New task closes the chooser and opens New task with a way back", () => {
		useWindowUiStore.setState({ newTaskRequest: null });
		render();
		const option = [...document.querySelectorAll('[role="option"]')].find((b) =>
			b.textContent?.includes("New task"),
		) as HTMLButtonElement;
		act(() => option.click());
		expect(onClose).toHaveBeenCalled();
		const req = useWindowUiStore.getState().newTaskRequest;
		expect(req).not.toBeNull();
		expect(req?.onBack).toBeTypeOf("function");
	});

	it("relaunches the whole Workspace in the background and closes", () => {
		render("relaunch");
		const row = [...document.querySelectorAll('[role="option"]')].find((b) =>
			b.textContent?.includes("api"),
		) as HTMLButtonElement;
		act(() => row.click());
		expect(usePtyActivityStore.getState().openedWorkspaceIds.has("api")).toBe(
			true,
		);
		expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
		expect(Object.keys(useWindowUiStore.getState().pendingTiles)).toEqual([
			"api-p",
		]);
		expect(onClose).toHaveBeenCalled();
	});
});
