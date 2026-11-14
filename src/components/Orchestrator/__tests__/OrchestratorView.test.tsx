import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The graph is not under test here, and React Flow needs layout APIs jsdom lacks.
vi.mock("../OrchestratorGraph", () => ({
	OrchestratorGraph: () => <div>GRAPH</div>,
}));
// The borrowed terminal is not under test here either.
vi.mock("../PeekPane", () => ({
	PeekPane: ({ paneId }: { paneId: string }) => <div>PEEK {paneId}</div>,
}));

import { closePeek, peekAgent } from "../../../lib/orchestratorActions";
import { useOrchestratorStore } from "../../../stores/orchestratorStore";
import { useWindowUiStore } from "../../../stores/windowUiStore";
import { OrchestratorView } from "../OrchestratorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoResize {
	observe() {}
	disconnect() {}
	unobserve() {}
}

describe("OrchestratorView", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoResize;
		useWindowUiStore.setState({
			orchestratorViewOpen: true,
			orchestratorTopCollapsed: false,
		});
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const render = () =>
		act(() => root.render(<OrchestratorView topOffset={0} />));

	it("shows the picker over the pane once its Agent has exited", () => {
		useOrchestratorStore.setState({
			phase: "ready",
			agentId: "claude",
			changingAgent: false,
			exited: true,
		});
		render();
		expect(host.textContent).toContain("The Orchestrator has stopped");
		expect(host.textContent).not.toContain("Starting the Orchestrator");
	});

	it("shows nothing over the pane while the Orchestrator runs", () => {
		useOrchestratorStore.setState({
			phase: "ready",
			agentId: "claude",
			changingAgent: false,
			exited: false,
		});
		render();
		expect(host.textContent).not.toContain("has stopped");
		expect(host.textContent).not.toContain("Starting the Orchestrator");
	});

	it("peeks at an Agent beside the graph, and closes the Peek", () => {
		useOrchestratorStore.setState({
			phase: "ready",
			agentId: "claude",
			changingAgent: false,
			exited: false,
			peekPaneId: null,
			selectedPaneId: null,
		});
		render();
		act(() => peekAgent("p1"));
		expect(useOrchestratorStore.getState()).toMatchObject({
			peekPaneId: "p1",
			selectedPaneId: "p1",
		});
		// Another Agent replaces it.
		act(() => peekAgent("p2"));
		expect(useOrchestratorStore.getState().peekPaneId).toBe("p2");
		act(() => closePeek());
		expect(useOrchestratorStore.getState().peekPaneId).toBeNull();
	});
});
