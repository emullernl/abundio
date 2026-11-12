import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../WorkspaceList", () => ({
	WorkspaceList: () => <div data-testid="workspace-list" />,
}));
vi.mock("../AgentsList", () => ({
	AgentsList: () => <div data-testid="agents-list" />,
}));

import { useWindowUiStore } from "../../../stores/windowUiStore";
import { Sidebar } from "../Sidebar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render() {
	act(() => {
		root.render(
			<Sidebar titlebarHeight={28} onRequestNewWorkspace={() => {}} />,
		);
	});
}

const has = (id: string) =>
	container.querySelector(`[data-testid="${id}"]`) !== null;
const divider = () => container.querySelector('[style*="row-resize"]');

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	useWindowUiStore.setState({
		sidebarCollapsed: false,
		agentsListCollapsed: false,
	});
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("Sidebar", () => {
	it("shows the Agents list under the Workspace list, with a divider", () => {
		render();
		expect(has("workspace-list")).toBe(true);
		expect(has("agents-list")).toBe(true);
		expect(divider()).not.toBeNull();
	});

	it("drops the divider while the Agents list is collapsed", () => {
		useWindowUiStore.setState({ agentsListCollapsed: true });
		render();
		expect(has("agents-list")).toBe(true);
		expect(divider()).toBeNull();
	});

	it("has no Agents list in the collapsed icon strip", () => {
		useWindowUiStore.setState({ sidebarCollapsed: true });
		render();
		expect(has("agents-list")).toBe(false);
	});
});
