import { describe, expect, it, vi } from "vitest";
import {
	firePaneSlot,
	registerPaneFire,
	unregisterPaneFire,
} from "../promptActionRegistry";

function handlers() {
	return { bySlot: vi.fn(), byAction: vi.fn() };
}

// A Fleet tile borrows a pane on top of its Workspace-view slot (ADR-0040).
describe("promptActionRegistry — several registrations per pane", () => {
	it("fires the highest-priority registration and falls back when it goes", () => {
		const slot = handlers();
		const tile = handlers();
		registerPaneFire("p1", slot);
		registerPaneFire("p1", tile, 1);

		firePaneSlot("p1", 2, false);
		expect(tile.bySlot).toHaveBeenCalledWith(2, false);
		expect(slot.bySlot).not.toHaveBeenCalled();

		unregisterPaneFire("p1", tile);
		firePaneSlot("p1", 3, true);
		expect(slot.bySlot).toHaveBeenCalledWith(3, true);
		unregisterPaneFire("p1");
	});

	it("a lower-priority slot re-registering does not take over from the tile", () => {
		const slot = handlers();
		const tile = handlers();
		registerPaneFire("p2", tile, 1);
		registerPaneFire("p2", slot);
		firePaneSlot("p2", 1, false);
		expect(tile.bySlot).toHaveBeenCalled();
		expect(slot.bySlot).not.toHaveBeenCalled();
		unregisterPaneFire("p2");
	});
});
