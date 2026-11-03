import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const raise = vi.fn((_id: string) => Promise.resolve());
const restore = vi.fn((_id: string) => Promise.resolve());
vi.mock("../../lib/ipc", () => ({
	markdownWindows: {
		raise: (id: string) => raise(id),
		restore: (id: string) => restore(id),
		close: () => Promise.resolve(),
	},
}));

import {
	afterRestore,
	raiseMarkdownWindows,
	restoreMarkdownWindows,
} from "../../lib/markdownWindowRaise";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useMarkdownWindowRaise } from "../useMarkdownWindowRaise";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
	useMarkdownWindowRaise();
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

describe("useMarkdownWindowRaise", () => {
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

describe("selecting the Active workspace again", () => {
	it("raises its Markdown windows", async () => {
		useWorkspaceStore.setState({ activeWorkspaceId: "w1" });
		useWorkspaceStore.getState().beginWorkspaceSwitch("w1");
		await flush();
		expect(raise).toHaveBeenCalledTimes(1);
		expect(raise).toHaveBeenLastCalledWith("w1");
	});
});

describe("raiseMarkdownWindows", () => {
	it("waits for a restore of the same Workspace in flight", async () => {
		let finish!: () => void;
		restore.mockImplementation(() => new Promise<void>((r) => (finish = r)));
		restoreMarkdownWindows("w1");
		const raised = raiseMarkdownWindows("w1");
		await flush();
		expect(raise).not.toHaveBeenCalled();

		finish();
		await raised;
		expect(raise).toHaveBeenCalledWith("w1");
	});

	it("still raises after a failed restore", async () => {
		restore.mockImplementation(() => Promise.reject(new Error("gone")));
		restoreMarkdownWindows("w1").catch(() => {});
		await raiseMarkdownWindows("w1");
		expect(raise).toHaveBeenCalledWith("w1");
	});

	it("logs a failed raise instead of throwing", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		raise.mockImplementation(() => Promise.reject(new Error("nope")));
		await expect(raiseMarkdownWindows("w1")).resolves.toBeUndefined();
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
		restoreMarkdownWindows("w1");
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
