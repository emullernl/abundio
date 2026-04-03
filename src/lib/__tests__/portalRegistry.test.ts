import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getTarget,
	onTargetChange,
	registerTarget,
	unregisterTarget,
} from "../portalRegistry";

// Clean up between tests by unregistering known pane IDs
const testPaneIds: string[] = [];
function trackPaneId(id: string) {
	testPaneIds.push(id);
	return id;
}

beforeEach(() => {
	for (const id of testPaneIds) {
		unregisterTarget(id);
	}
	testPaneIds.length = 0;
});

describe("registerTarget / getTarget / unregisterTarget", () => {
	it("registers and retrieves a target", () => {
		const id = trackPaneId("pane-1");
		const el = document.createElement("div");
		registerTarget(id, el);
		expect(getTarget(id)).toBe(el);
	});

	it("returns null for unregistered pane", () => {
		expect(getTarget("nonexistent")).toBeNull();
	});

	it("unregisters a target", () => {
		const id = trackPaneId("pane-2");
		const el = document.createElement("div");
		registerTarget(id, el);
		unregisterTarget(id);
		expect(getTarget(id)).toBeNull();
	});

	it("multiple targets coexist", () => {
		const id1 = trackPaneId("pane-a");
		const id2 = trackPaneId("pane-b");
		const el1 = document.createElement("div");
		const el2 = document.createElement("div");
		registerTarget(id1, el1);
		registerTarget(id2, el2);
		expect(getTarget(id1)).toBe(el1);
		expect(getTarget(id2)).toBe(el2);
	});

	it("overwrites on re-register", () => {
		const id = trackPaneId("pane-3");
		const el1 = document.createElement("div");
		const el2 = document.createElement("div");
		registerTarget(id, el1);
		registerTarget(id, el2);
		expect(getTarget(id)).toBe(el2);
	});
});

describe("onTargetChange", () => {
	it("fires callback on register", () => {
		const id = trackPaneId("pane-cb-1");
		const cb = vi.fn();
		const cleanup = onTargetChange(id, cb);

		const el = document.createElement("div");
		registerTarget(id, el);
		expect(cb).toHaveBeenCalledWith(el);

		cleanup();
	});

	it("fires callback with null on unregister", () => {
		const id = trackPaneId("pane-cb-2");
		const el = document.createElement("div");
		registerTarget(id, el);

		const cb = vi.fn();
		const cleanup = onTargetChange(id, cb);

		unregisterTarget(id);
		expect(cb).toHaveBeenCalledWith(null);

		cleanup();
	});

	it("cleanup removes the listener", () => {
		const id = trackPaneId("pane-cb-3");
		const cb = vi.fn();
		const cleanup = onTargetChange(id, cb);
		cleanup();

		const el = document.createElement("div");
		registerTarget(id, el);
		expect(cb).not.toHaveBeenCalled();
	});

	it("multiple listeners for same pane all fire", () => {
		const id = trackPaneId("pane-cb-4");
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		const cleanup1 = onTargetChange(id, cb1);
		const cleanup2 = onTargetChange(id, cb2);

		const el = document.createElement("div");
		registerTarget(id, el);
		expect(cb1).toHaveBeenCalledWith(el);
		expect(cb2).toHaveBeenCalledWith(el);

		cleanup1();
		cleanup2();
	});

	it("listener for pane A does not fire on pane B changes", () => {
		const idA = trackPaneId("pane-cb-a");
		const idB = trackPaneId("pane-cb-b");
		const cb = vi.fn();
		const cleanup = onTargetChange(idA, cb);

		registerTarget(idB, document.createElement("div"));
		expect(cb).not.toHaveBeenCalled();

		cleanup();
	});
});
