import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrchestratorStore } from "../../stores/orchestratorStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	cycleFleet,
	focusedPeekPaneId,
	focusLeavesPeek,
	focusPaneForInput,
	isFleetTileOnScreen,
	navigateFleet,
	publishFleetGrid,
	stepTileZoom,
	targetPaneId,
	toggleFleetSpotlight,
	workspaceViewOnly,
} from "../fleetFocus";

// Keyboard routing while the Fleet Console is on screen (ADR-0040).
describe("fleetFocus", () => {
	beforeEach(() => {
		useWindowUiStore.setState({
			fleetConsoleOpen: false,
			orchestratorViewOpen: false,
			statisticsOverlayOpen: false,
			focusedTileId: null,
			spotlightTileId: null,
		});
		useWorkspaceStore.setState({ focusedPaneId: "ws-pane" });
	});

	it("targets the Focused pane in the Workspace view", () => {
		useWindowUiStore.setState({ focusedTileId: "tile-1" });
		expect(targetPaneId()).toBe("ws-pane");
	});

	it("targets the Focused tile in the console", () => {
		useWindowUiStore.setState({
			fleetConsoleOpen: true,
			focusedTileId: "tile-1",
		});
		expect(targetPaneId()).toBe("tile-1");
	});

	it("targets the Focused pane again while Statistics covers the console", () => {
		useWindowUiStore.setState({
			fleetConsoleOpen: true,
			statisticsOverlayOpen: true,
			focusedTileId: "tile-1",
		});
		expect(targetPaneId()).toBe("ws-pane");
	});

	it("mutes Workspace-view shortcuts in the console", () => {
		const fn = vi.fn();
		const wrapped = workspaceViewOnly(fn);
		wrapped();
		expect(fn).toHaveBeenCalledTimes(1);
		useWindowUiStore.setState({ fleetConsoleOpen: true });
		wrapped();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("walks the grid as drawn", () => {
		// a b c
		// d e
		publishFleetGrid(["a", "b", "c", "d", "e"], 3);
		useWindowUiStore.setState({ fleetConsoleOpen: true, focusedTileId: "b" });
		navigateFleet("down");
		expect(useWindowUiStore.getState().focusedTileId).toBe("e");
		navigateFleet("right");
		expect(useWindowUiStore.getState().focusedTileId).toBe("e");
		cycleFleet(1);
		expect(useWindowUiStore.getState().focusedTileId).toBe("a");
		cycleFleet(-1);
		expect(useWindowUiStore.getState().focusedTileId).toBe("e");
	});

	it("a move with no focused tile lands on the first tile", () => {
		publishFleetGrid(["a", "b"], 2);
		useWindowUiStore.setState({ fleetConsoleOpen: true, focusedTileId: null });
		navigateFleet("left");
		expect(useWindowUiStore.getState().focusedTileId).toBe("a");
	});
});

// Spotlight and Tile zoom — see the Spotlight and Tile zoom entries in GLOSSARY.md.
describe("fleetFocus — Spotlight", () => {
	beforeEach(() => {
		// a b c d, spotlight on b
		publishFleetGrid(["a", "b", "c", "d"], 2);
		useWindowUiStore.setState({
			fleetConsoleOpen: true,
			statisticsOverlayOpen: false,
			spotlightTileId: "b",
			focusedTileId: "b",
		});
	});

	it("Pane cycle moves the spotlight and the focus with it", () => {
		cycleFleet(1);
		expect(useWindowUiStore.getState().spotlightTileId).toBe("c");
		expect(useWindowUiStore.getState().focusedTileId).toBe("c");
		cycleFleet(-1);
		cycleFleet(-1);
		expect(useWindowUiStore.getState().spotlightTileId).toBe("a");
	});

	it("Directional move walks the Filmstrip and back", () => {
		navigateFleet("right");
		expect(useWindowUiStore.getState().focusedTileId).toBe("a");
		navigateFleet("down");
		expect(useWindowUiStore.getState().focusedTileId).toBe("c");
		navigateFleet("down");
		navigateFleet("down");
		expect(useWindowUiStore.getState().focusedTileId).toBe("d");
		navigateFleet("left");
		expect(useWindowUiStore.getState().focusedTileId).toBe("b");
		expect(useWindowUiStore.getState().spotlightTileId).toBe("b");
	});

	it("the toggle spotlights the Focused tile, and ends Spotlight on it", () => {
		toggleFleetSpotlight();
		expect(useWindowUiStore.getState().spotlightTileId).toBeNull();
		useWindowUiStore.setState({ focusedTileId: "d" });
		toggleFleetSpotlight();
		expect(useWindowUiStore.getState().spotlightTileId).toBe("d");
	});

	it("zoom steps by 5% within 50–100% and resets to 75%", () => {
		useWindowUiStore.getState().setTileZoom(0.75);
		stepTileZoom(1);
		expect(useWindowUiStore.getState().fleetGrid.zoom).toBe(0.8);
		for (let i = 0; i < 10; i++) stepTileZoom(1);
		expect(useWindowUiStore.getState().fleetGrid.zoom).toBe(1);
		for (let i = 0; i < 20; i++) stepTileZoom(-1);
		expect(useWindowUiStore.getState().fleetGrid.zoom).toBe(0.5);
		stepTileZoom(0);
		expect(useWindowUiStore.getState().fleetGrid.zoom).toBe(0.75);
	});

	it("choosing a grid size ends Spotlight", () => {
		useWindowUiStore.getState().setFleetPreset("auto");
		expect(useWindowUiStore.getState().spotlightTileId).toBeNull();
	});

	// Switch to an agent and back resumes where the user left off.
	it("closing and reopening the console keeps Spotlight and focus", () => {
		const ui = useWindowUiStore.getState();
		ui.toggleFleetConsole();
		expect(useWindowUiStore.getState().fleetConsoleOpen).toBe(false);
		useWindowUiStore.getState().setFleetConsoleOpen(true);
		const s = useWindowUiStore.getState();
		expect(s.spotlightTileId).toBe("b");
		expect(s.focusedTileId).toBe("b");
	});
});

// Code-review fixes: focus and visibility follow the view on screen.
describe("fleetFocus — input focus and on-screen tiles", () => {
	beforeEach(() => {
		useWindowUiStore.setState({
			fleetConsoleOpen: false,
			statisticsOverlayOpen: false,
			focusedTileId: null,
		});
		useWorkspaceStore.setState({ focusedPaneId: "ws-pane" });
		document.body.innerHTML = "";
	});

	it("acting on a pane in the console moves the Focused tile, not the Workspace view", () => {
		useWindowUiStore.setState({ fleetConsoleOpen: true });
		focusPaneForInput("tile-pane");
		expect(useWindowUiStore.getState().focusedTileId).toBe("tile-pane");
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("ws-pane");
	});

	it("outside the console it moves the Focused pane", () => {
		focusPaneForInput("other-pane");
		expect(useWorkspaceStore.getState().focusedPaneId).toBe("other-pane");
		expect(useWindowUiStore.getState().focusedTileId).toBeNull();
	});

	it("a tile scrolled out of the Console's area is not on screen", () => {
		useWindowUiStore.setState({ fleetConsoleOpen: true });
		publishFleetGrid(["near", "far"], 1);
		const area = document.createElement("div");
		area.setAttribute("data-fleet-scroll", "");
		const tile = (id: string, top: number) => {
			const el = document.createElement("div");
			el.setAttribute("data-fleet-tile", id);
			el.getBoundingClientRect = () =>
				({
					top,
					bottom: top + 100,
					left: 0,
					right: 100,
					width: 100,
					height: 100,
				}) as DOMRect;
			area.appendChild(el);
		};
		area.getBoundingClientRect = () =>
			({
				top: 0,
				bottom: 300,
				left: 0,
				right: 100,
				width: 100,
				height: 300,
			}) as DOMRect;
		tile("near", 50);
		tile("far", 900);
		document.body.appendChild(area);
		expect(isFleetTileOnScreen("near")).toBe(true);
		expect(isFleetTileOnScreen("far")).toBe(false);
		expect(isFleetTileOnScreen("not-a-tile")).toBe(false);
	});

	describe("the Peek in the Orchestrator view", () => {
		beforeEach(() => {
			useWindowUiStore.setState({ orchestratorViewOpen: true });
			useOrchestratorStore.setState({
				peekPaneId: "peeked",
				peekFocused: false,
				fileTabFocused: false,
			});
		});

		it("targets the peeked pane while the Peek has the keyboard", () => {
			useOrchestratorStore.setState({ peekFocused: true });
			expect(focusedPeekPaneId()).toBe("peeked");
			expect(targetPaneId()).toBe("peeked");
		});

		it("targets the Focused pane while the Peek does not", () => {
			expect(focusedPeekPaneId()).toBeNull();
			expect(targetPaneId()).toBe("ws-pane");
		});

		it("ignores a stale Peek focus once the view is gone", () => {
			useOrchestratorStore.setState({ peekFocused: true });
			useWindowUiStore.setState({ orchestratorViewOpen: false });
			expect(targetPaneId()).toBe("ws-pane");
			useWindowUiStore.setState({
				orchestratorViewOpen: true,
				statisticsOverlayOpen: true,
			});
			expect(targetPaneId()).toBe("ws-pane");
		});

		it("lets the Fleet Console's Focused tile win", () => {
			useOrchestratorStore.setState({ peekFocused: true });
			useWindowUiStore.setState({
				fleetConsoleOpen: true,
				focusedTileId: "tile-1",
			});
			expect(targetPaneId()).toBe("tile-1");
		});

		it("acting on the peeked pane focuses the Peek, not the Focused pane", () => {
			useOrchestratorStore.setState({ fileTabFocused: true });
			focusPaneForInput("peeked");
			expect(useOrchestratorStore.getState().peekFocused).toBe(true);
			expect(useOrchestratorStore.getState().fileTabFocused).toBe(false);
			expect(useWorkspaceStore.getState().focusedPaneId).toBe("ws-pane");
		});

		it("gives the Peek's keyboard up only to another pane", () => {
			document.body.innerHTML = `
				<div data-peek-pane><div data-pane-id="peeked"><textarea id="in-peek"></textarea></div></div>
				<div data-pane-id="orch-pane"><textarea id="in-orch"></textarea></div>
				<div id="graph"><button id="node"></button></div>`;
			const at = (id: string) => document.getElementById(id);
			expect(focusLeavesPeek(at("in-orch"))).toBe(true);
			expect(focusLeavesPeek(at("in-peek"))).toBe(false);
			// The graph, the palette, a menu: shortcuts still reach the Peek.
			expect(focusLeavesPeek(at("node"))).toBe(false);
			expect(focusLeavesPeek(null)).toBe(false);
			document.body.innerHTML = "";
		});

		it("acting on another pane focuses it as before", () => {
			focusPaneForInput("orch-pane");
			expect(useOrchestratorStore.getState().peekFocused).toBe(false);
			expect(useWorkspaceStore.getState().focusedPaneId).toBe("orch-pane");
		});
	});
});
