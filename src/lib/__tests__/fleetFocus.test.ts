import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	cycleFleet,
	navigateFleet,
	publishFleetGrid,
	targetPaneId,
	workspaceViewOnly,
} from "../fleetFocus";

// Keyboard routing while the Fleet Console is on screen (ADR-0040).
describe("fleetFocus", () => {
	beforeEach(() => {
		useWindowUiStore.setState({
			fleetConsoleOpen: false,
			statisticsOverlayOpen: false,
			focusedTileId: null,
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
