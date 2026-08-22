import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaneNode } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActiveLayout } from "../useActiveLayout";

const LAYOUT: PaneNode = { type: "file", id: "pane-1", filePath: "/repo/a.ts" };

function seed(layout: PaneNode = LAYOUT) {
	useWorkspaceStore.setState({
		activeWorkspaceId: "ws-1",
		activeTabByWorkspace: { "ws-1": "tab-1" },
		workspaces: [
			{
				id: "ws-1",
				name: "ws-1",
				rootFolder: "/repo",
				agentPresetsJson: "[]",
				fileTabsJson: "[]",
				baseBranch: null,
				lastBranch: null,
				position: 0,
				profileId: "p1",
				createdAt: 0,
				updatedAt: 0,
				worktreeSetupCommands: "",
				tabs: [
					{
						id: "tab-1",
						workspaceId: "ws-1",
						name: "Tab",
						layoutJson: JSON.stringify(layout),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			},
		],
		// biome-ignore lint/suspicious/noExplicitAny: partial store for the test
	} as any);
}

describe("useActiveLayout", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders: number;
	let seenLayouts: (PaneNode | null)[];

	const last = () => seenLayouts[seenLayouts.length - 1];

	function Probe() {
		renders++;
		seenLayouts.push(useActiveLayout());
		return null;
	}

	beforeEach(() => {
		renders = 0;
		seenLayouts = [];
		seed();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("parses the active tab's layout", () => {
		act(() => root.render(<Probe />));
		expect(last()).toEqual(LAYOUT);
	});

	it("does not re-render forever on mount", () => {
		// The regression: `useWorkspaceStore((s) => s.getActiveLayout())` returns a
		// freshly parsed object every call, so the selector never settles and React
		// bails out with "Maximum update depth exceeded".
		act(() => root.render(<Probe />));
		expect(renders).toBeLessThan(5);
	});

	it("returns the same reference across unrelated store updates", () => {
		act(() => root.render(<Probe />));
		const first = last();

		act(() => {
			useWorkspaceStore.setState({ focusedPaneId: "pane-1" });
		});
		act(() => {
			useWorkspaceStore.setState({ focusedPaneId: "pane-2" });
		});

		expect(last()).toBe(first);
	});

	it("returns a new value when the layout actually changes", () => {
		act(() => root.render(<Probe />));
		const first = last();

		const next: PaneNode = {
			type: "file",
			id: "pane-2",
			filePath: "/repo/b.ts",
		};
		act(() => seed(next));

		expect(last()).not.toBe(first);
		expect(last()).toEqual(next);
	});

	it("is null when there is no active tab", () => {
		// biome-ignore lint/suspicious/noExplicitAny: partial store for the test
		act(() => useWorkspaceStore.setState({ workspaces: [] } as any));
		act(() => root.render(<Probe />));
		expect(last()).toBeNull();
	});
});
