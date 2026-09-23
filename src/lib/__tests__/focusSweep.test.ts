import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	installFocusSweep,
	shouldSweep,
	useFocusSweepStore,
} from "../focusSweep";

describe("shouldSweep", () => {
	it("sweeps a change to a different pane", () => {
		expect(shouldSweep("a", "b", true, false, true)).toBe(true);
	});

	it("sweeps focus arriving from nothing, once focus has been seen", () => {
		expect(shouldSweep(null, "b", true, false, true)).toBe(true);
	});

	it("skips the first focus after the Window opens", () => {
		expect(shouldSweep(null, "a", false, false, true)).toBe(false);
	});

	it("never sweeps re-focusing the same pane, or focus going away", () => {
		expect(shouldSweep("a", "a", true, false, true)).toBe(false);
		expect(shouldSweep("a", null, true, false, true)).toBe(false);
	});

	it("skips a switch of Active workspace", () => {
		expect(shouldSweep("a", "b", true, true, true)).toBe(false);
	});

	it("is off when the setting is off", () => {
		expect(shouldSweep("a", "b", true, false, false)).toBe(false);
	});
});

describe("installFocusSweep", () => {
	let uninstall: () => void;

	beforeEach(() => {
		useWorkspaceStore.setState({ focusedPaneId: null });
		useFocusSweepStore.setState({ paneId: null, nonce: 0 });
		useSettingsStore.setState({ focusSweep: true });
		uninstall = installFocusSweep();
	});

	afterEach(() => uninstall());

	const focus = (id: string | null) =>
		useWorkspaceStore.setState({ focusedPaneId: id });

	it("skips launch, then sweeps each new Focused pane", () => {
		focus("a");
		expect(useFocusSweepStore.getState().paneId).toBeNull();
		focus("b");
		expect(useFocusSweepStore.getState().paneId).toBe("b");
		focus("a");
		expect(useFocusSweepStore.getState().paneId).toBe("a");
	});

	it("sweeps after focus passes through nothing (a closed workspace)", () => {
		focus("a");
		focus(null);
		focus("b");
		expect(useFocusSweepStore.getState().paneId).toBe("b");
	});

	it("lets only the newest sweep finish itself", () => {
		focus("a");
		focus("b");
		const first = useFocusSweepStore.getState().nonce;
		focus("c");
		useFocusSweepStore.getState().finish(first);
		expect(useFocusSweepStore.getState().paneId).toBe("c");
		useFocusSweepStore.getState().finish(useFocusSweepStore.getState().nonce);
		expect(useFocusSweepStore.getState().paneId).toBeNull();
	});

	it("does not sweep a workspace switch, but does sweep moves after it", () => {
		useWorkspaceStore.setState({ activeWorkspaceId: "w1" });
		focus("a");
		useWorkspaceStore.setState({ activeWorkspaceId: "w2", focusedPaneId: "b" });
		expect(useFocusSweepStore.getState().paneId).toBeNull();
		focus("c");
		expect(useFocusSweepStore.getState().paneId).toBe("c");
	});

	it("respects the setting at the moment focus moves", () => {
		focus("a");
		useSettingsStore.setState({ focusSweep: false });
		focus("b");
		expect(useFocusSweepStore.getState().paneId).toBeNull();
	});
});
