import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const raise = vi.fn((_id: string) => Promise.resolve());
const restore = vi.fn((_id: string) => Promise.resolve());
vi.mock("../../lib/ipc", () => ({
	fileWindows: {
		raise: (id: string) => raise(id),
		restore: (id: string) => restore(id),
		close: () => Promise.resolve(),
	},
}));

import {
	afterRestore,
	raiseFileWindows,
	restoreFileWindows,
} from "../../lib/fileWindowRaise";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useFileWindowRaise } from "../useFileWindowRaise";
import { useFileWindowRestore } from "../useFileWindowRestore";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
	useFileWindowRaise();
	return null;
}

/** Lets queued promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	raise.mockClear();
	restore.mockClear();
	raise.mockImplementation(() => Promise.resolve());
	restore.mockImplementation(() => Promise.resolve());
	useWorkspaceStore.setState({
		activeWorkspaceId: null,
		switchingWorkspaceId: null,
	});
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
});

describe("useFileWindowRaise", () => {
	it("raises the Workspace that becomes Active, once per change", async () => {
		act(() => root.render(<Probe />));
		act(() => useWorkspaceStore.setState({ activeWorkspaceId: "w1" }));
		await flush();
		expect(raise).toHaveBeenCalledTimes(1);
		expect(raise).toHaveBeenLastCalledWith("w1");

		// Unrelated store churn does not raise again.
		act(() => useWorkspaceStore.setState({ focusedPaneId: "p1" }));
		await flush();
		expect(raise).toHaveBeenCalledTimes(1);

		act(() => useWorkspaceStore.setState({ activeWorkspaceId: "w2" }));
		await flush();
		expect(raise).toHaveBeenCalledTimes(2);
		expect(raise).toHaveBeenLastCalledWith("w2");
	});

	it("does not raise when there is no Active workspace", async () => {
		useWorkspaceStore.setState({ activeWorkspaceId: "w1" });
		act(() => root.render(<Probe />));
		act(() => useWorkspaceStore.setState({ activeWorkspaceId: null }));
		await flush();
		expect(raise).not.toHaveBeenCalled();
	});

	it("does not raise for the Workspace already Active at mount", async () => {
		useWorkspaceStore.setState({ activeWorkspaceId: "w1" });
		act(() => root.render(<Probe />));
		await flush();
		expect(raise).not.toHaveBeenCalled();
	});
});

describe("first activation of a Workspace", () => {
	function BothHooks() {
		useFileWindowRestore();
		useFileWindowRaise();
		return null;
	}

	it("raises only after the restore that reopens its windows", async () => {
		// Guards the order in setActiveWorkspace: markWorkspaceOpened (which
		// starts the restore) must run before activeWorkspaceId changes.
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
		let finish!: () => void;
		restore.mockImplementation(() => new Promise<void>((r) => (finish = r)));
		act(() => root.render(<BothHooks />));

		act(() => useWorkspaceStore.getState().setActiveWorkspace("w1"));
		await flush();
		expect(restore).toHaveBeenCalledWith("w1");
		expect(raise).not.toHaveBeenCalled();

		finish();
		await flush();
		expect(raise).toHaveBeenCalledWith("w1");
	});
});

describe("selecting the Active workspace again", () => {
	it("raises its File windows", async () => {
		useWorkspaceStore.setState({ activeWorkspaceId: "w1" });
		useWorkspaceStore.getState().beginWorkspaceSwitch("w1");
		await flush();
		expect(raise).toHaveBeenCalledTimes(1);
		expect(raise).toHaveBeenLastCalledWith("w1");
	});
});

describe("raiseFileWindows", () => {
	it("waits for a restore of the same Workspace in flight", async () => {
		let finish!: () => void;
		restore.mockImplementation(() => new Promise<void>((r) => (finish = r)));
		restoreFileWindows("w1");
		const raised = raiseFileWindows("w1");
		await flush();
		expect(raise).not.toHaveBeenCalled();

		finish();
		await raised;
		expect(raise).toHaveBeenCalledWith("w1");
	});

	it("still raises after a failed restore", async () => {
		restore.mockImplementation(() => Promise.reject(new Error("gone")));
		restoreFileWindows("w1").catch(() => {});
		await raiseFileWindows("w1");
		expect(raise).toHaveBeenCalledWith("w1");
	});

	it("logs a failed raise instead of throwing", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		raise.mockImplementation(() => Promise.reject(new Error("nope")));
		await expect(raiseFileWindows("w1")).resolves.toBeUndefined();
		expect(err).toHaveBeenCalled();
		err.mockRestore();
	});
});

describe("afterRestore", () => {
	it("settles at once when no restore is in flight", async () => {
		await expect(afterRestore("none")).resolves.toBeUndefined();
	});

	it("settles only after the pending restore", async () => {
		let finish!: () => void;
		restore.mockImplementation(() => new Promise<void>((r) => (finish = r)));
		restoreFileWindows("w1");
		let settled = false;
		afterRestore("w1").then(() => {
			settled = true;
		});
		await flush();
		expect(settled).toBe(false);
		finish();
		await flush();
		expect(settled).toBe(true);
	});
});
