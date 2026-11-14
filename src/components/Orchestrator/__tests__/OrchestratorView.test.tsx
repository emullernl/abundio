import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The graph is not under test here, and React Flow needs layout APIs jsdom lacks.
vi.mock("../OrchestratorGraph", () => ({ OrchestratorGraph: () => null }));

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
			orchestratorTopCollapsed: true,
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
});
