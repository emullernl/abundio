import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../TerminalInstance", () => ({
	TerminalInstance: ({ paneId }: { paneId: string }) => (
		<div data-terminal={paneId} />
	),
}));

import type { WorkspaceWithTabs } from "../../../lib/types";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { TerminalPool } from "../TerminalPool";

function ws(id: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		tabs: [
			{
				id: `${id}-t`,
				workspaceId: id,
				name: "Tab",
				layoutJson: JSON.stringify({
					type: "terminal",
					id: `${id}-p`,
					ptyId: "",
				}),
				position: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		],
	} as unknown as WorkspaceWithTabs;
}

describe("TerminalPool", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const rendered = () =>
		[...container.querySelectorAll("[data-terminal]")].map((e) =>
			e.getAttribute("data-terminal"),
		);

	it("holds back background workspaces while the active one starts", () => {
		useWorkspaceStore.setState({
			workspaces: [ws("a"), ws("b")],
			activeWorkspaceId: "a",
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["a", "b"]) });
		act(() => root.render(<TerminalPool />));
		expect(rendered()).toEqual(["a-p"]);
	});

	// A Workspace opened from the Fleet Console before any was activated: with
	// nothing to put first, waiting for an active workspace would be forever.
	it("loads every opened workspace when none is active", () => {
		useWorkspaceStore.setState({
			workspaces: [ws("a"), ws("b")],
			activeWorkspaceId: null,
		});
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["b"]) });
		act(() => root.render(<TerminalPool />));
		expect(rendered()).toEqual(["b-p"]);
	});
});
