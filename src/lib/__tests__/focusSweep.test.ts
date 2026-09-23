import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	installFocusSweep,
	shouldSweep,
	useFocusSweepStore,
	waitForSmoothFrames,
} from "../focusSweep";
import type { PaneNode } from "../types";

describe("shouldSweep", () => {
	it("sweeps a change to a different pane", () => {
		expect(shouldSweep("a", "b", 2, true)).toBe(true);
	});

	it("sweeps focus arriving from nothing — including the first after launch", () => {
		expect(shouldSweep(null, "a", 3, true)).toBe(true);
	});

	it("never sweeps in a Tab with a single Pane", () => {
		expect(shouldSweep("a", "b", 1, true)).toBe(false);
		expect(shouldSweep(null, "a", 1, true)).toBe(false);
	});

	it("never sweeps re-focusing the same pane, or focus going away", () => {
		expect(shouldSweep("a", "a", 2, true)).toBe(false);
		expect(shouldSweep("a", null, 2, true)).toBe(false);
	});

	it("is off when the setting is off", () => {
		expect(shouldSweep("a", "b", 2, false)).toBe(false);
	});
});

describe("installFocusSweep", () => {
	const t = (id: string): PaneNode => ({ type: "terminal", id, ptyId: "" });
	const split = (first: PaneNode, second: PaneNode): PaneNode => ({
		type: "split",
		id: `s-${first.id}-${second.id}`,
		direction: "vertical",
		ratio: 0.5,
		first,
		second,
	});
	const original = useWorkspaceStore.getState().getActiveLayout;
	let layout: PaneNode | null = null;
	let uninstall: () => void;

	beforeEach(() => {
		layout = split(t("a"), split(t("b"), t("c")));
		useWorkspaceStore.setState({
			focusedPaneId: null,
			getActiveLayout: () => layout,
		});
		useFocusSweepStore.setState({ paneId: null, nonce: 0 });
		useSettingsStore.setState({ focusSweep: true });
		uninstall = installFocusSweep();
	});

	afterEach(() => {
		uninstall();
		useWorkspaceStore.setState({ getActiveLayout: original });
	});

	const focus = (id: string | null) =>
		useWorkspaceStore.setState({ focusedPaneId: id });
	const sweeping = () => useFocusSweepStore.getState().paneId;

	it("sweeps the first focus after launch, then each new Focused pane", () => {
		focus("a");
		expect(sweeping()).toBe("a");
		focus("b");
		expect(sweeping()).toBe("b");
	});

	it("does not sweep a Tab with a single Pane", () => {
		layout = t("solo");
		focus("solo");
		expect(sweeping()).toBeNull();
	});

	it("stops once closing panes leaves one behind — and drops the old sweep", () => {
		focus("a");
		layout = t("b");
		focus("b");
		expect(sweeping()).toBeNull();
	});

	it("drops a sweep when focus moves to a single-pane Tab, so it cannot replay", () => {
		focus("a");
		expect(sweeping()).toBe("a");
		// Switch to a single-pane Tab: pane a's Tab is hidden mid-sweep.
		layout = t("solo");
		focus("solo");
		expect(sweeping()).toBeNull();
		// Back to the first Tab: nothing should be left to replay on pane a.
		layout = split(t("a"), split(t("b"), t("c")));
		useWorkspaceStore.setState({ activeWorkspaceId: "unchanged" });
		expect(sweeping()).toBeNull();
	});

	it("sweeps after focus passes through nothing (a closed workspace)", () => {
		focus("a");
		focus(null);
		focus("b");
		expect(sweeping()).toBe("b");
	});

	it("lets only the newest sweep finish itself", () => {
		focus("b");
		const first = useFocusSweepStore.getState().nonce;
		focus("c");
		useFocusSweepStore.getState().finish(first);
		expect(sweeping()).toBe("c");
		useFocusSweepStore.getState().finish(useFocusSweepStore.getState().nonce);
		expect(sweeping()).toBeNull();
	});

	it("respects the setting at the moment focus moves", () => {
		useSettingsStore.setState({ focusSweep: false });
		focus("b");
		expect(sweeping()).toBeNull();
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
