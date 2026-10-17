import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const restore = vi.fn((_id: string) => Promise.resolve());
vi.mock("../../lib/ipc", () => ({
	markdownWindows: { restore: (id: string) => restore(id) },
}));

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import {
	newlyOpened,
	useMarkdownWindowRestore,
} from "../useMarkdownWindowRestore";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
	useMarkdownWindowRestore();
	return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	restore.mockClear();
	usePtyActivityStore.setState({ openedWorkspaceIds: new Set() });
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
});

describe("newlyOpened", () => {
	it("lists only ids that just became Opened", () => {
		expect(newlyOpened(new Set(["a"]), new Set(["a", "b"]))).toEqual(["b"]);
		expect(newlyOpened(new Set(["a", "b"]), new Set(["a"]))).toEqual([]);
		expect(newlyOpened(new Set(), new Set())).toEqual([]);
	});
});

describe("useMarkdownWindowRestore", () => {
	it("restores the Workspaces already Opened at mount", () => {
		usePtyActivityStore.setState({ openedWorkspaceIds: new Set(["w1", "w2"]) });
		act(() => root.render(<Probe />));
		expect(restore.mock.calls.map((c) => c[0]).sort()).toEqual(["w1", "w2"]);
	});

	it("restores each newly Opened Workspace once", () => {
		act(() => root.render(<Probe />));
		expect(restore).not.toHaveBeenCalled();

		act(() => usePtyActivityStore.getState().markWorkspaceOpened("w1"));
		expect(restore).toHaveBeenCalledTimes(1);
		expect(restore).toHaveBeenLastCalledWith("w1");

		// Unrelated store churn and a repeat mark do not restore again.
		act(() => usePtyActivityStore.setState({ activities: {} }));
		act(() => usePtyActivityStore.getState().markWorkspaceOpened("w1"));
		expect(restore).toHaveBeenCalledTimes(1);

		// Closing does not restore; opening again does.
		act(() => usePtyActivityStore.getState().unmarkWorkspaceOpened("w1"));
		act(() => usePtyActivityStore.getState().markWorkspaceOpened("w1"));
		expect(restore).toHaveBeenCalledTimes(2);
	});

	it("stops listening when unmounted", () => {
		act(() => root.render(<Probe />));
		act(() => root.unmount());
		usePtyActivityStore.getState().markWorkspaceOpened("w9");
		expect(restore).not.toHaveBeenCalled();
		// afterEach unmounts again; give it a fresh root.
		root = createRoot(container);
	});
});
