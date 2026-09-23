import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	installFocusSweep,
	shouldSweep,
	useFocusSweepStore,
	waitForSmoothFrames,
} from "../focusSweep";

describe("shouldSweep", () => {
	it("sweeps a change to a different pane", () => {
		expect(shouldSweep("a", "b", true, true)).toBe(true);
	});

	it("sweeps focus arriving from nothing, once focus has been seen", () => {
		expect(shouldSweep(null, "b", true, true)).toBe(true);
	});

	it("skips the first focus after the Window opens", () => {
		expect(shouldSweep(null, "a", false, true)).toBe(false);
	});

	it("never sweeps re-focusing the same pane, or focus going away", () => {
		expect(shouldSweep("a", "a", true, true)).toBe(false);
		expect(shouldSweep("a", null, true, true)).toBe(false);
	});

	it("is off when the setting is off", () => {
		expect(shouldSweep("a", "b", true, false)).toBe(false);
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

	it("respects the setting at the moment focus moves", () => {
		focus("a");
		useSettingsStore.setState({ focusSweep: false });
		focus("b");
		expect(useFocusSweepStore.getState().paneId).toBeNull();
	});
});

describe("waitForSmoothFrames", () => {
	/** Drive `waitForSmoothFrames` with a scripted list of frame gaps. */
	function run(gaps: number[]): number | null {
		let pending: FrameRequestCallback | null = null;
		let t = 0;
		let startedAt: number | null = null;
		waitForSmoothFrames(
			() => {
				startedAt = t;
			},
			(cb) => {
				pending = cb;
				return 1;
			},
			() => {},
			() => 0,
		);
		for (const gap of gaps) {
			const cb = pending as FrameRequestCallback | null;
			if (!cb || startedAt !== null) break;
			pending = null;
			t += gap;
			cb(t);
		}
		return startedAt;
	}

	it("starts after two smooth frames when nothing is busy", () => {
		expect(run([16, 17, 16])).toBe(33);
	});

	it("waits out a stall, like the one a workspace switch causes", () => {
		// Measured in the demo: one normal frame, then 120 + 180 ms of layout.
		expect(run([19, 120, 180, 20, 20, 20])).toBe(359);
	});

	it("gives up waiting after a second", () => {
		expect(run([400, 400, 400, 400])).toBe(1200);
	});
});
