import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeSync } from "../useWorktreeSync";

const { focusListeners } = vi.hoisted(() => ({
	focusListeners: [] as ((focused: boolean) => void)[],
}));

vi.mock("../../lib/windowFocus", () => ({
	isAppWindowFocused: () => true,
	getWindowBlurredMs: () => null,
	addWindowFocusListener: (l: (focused: boolean) => void) => {
		focusListeners.push(l);
		return () => {
			focusListeners.splice(focusListeners.indexOf(l), 1);
		};
	},
}));

vi.mock("../../lib/ipc", () => ({
	worktrees: {
		watchSet: vi.fn().mockResolvedValue(undefined),
		onChanged: vi.fn().mockResolvedValue(() => {}),
		list: vi.fn(),
	},
	git: {},
	workspaces: {},
	pty: {},
	tabs: {},
}));

function ws(id: string): WorkspaceWithTabs {
	return {
		id,
		name: id,
		rootFolder: `/${id}`,
		agentPresetsJson: "[]",
		fileTabsJson: "[]",
		baseBranch: null,
		lastBranch: null,
		position: 0,
		profileId: "p1",
		createdAt: 0,
		updatedAt: 0,
		worktreeSetupCommands: "",
		tabs: [],
	};
}

function Harness() {
	useWorktreeSync();
	return null;
}

describe("useWorktreeSync focus refresh", () => {
	let container: HTMLDivElement;
	let root: Root;
	let sync: ReturnType<
		typeof vi.fn<(workspaces: { id: string }[]) => Promise<void>>
	>;

	beforeEach(async () => {
		focusListeners.length = 0;
		sync = vi
			.fn<(workspaces: { id: string }[]) => Promise<void>>()
			.mockResolvedValue(undefined);
		useWorkspaceGitStore.setState({
			syncWorktreeFacts: sync,
			worktreeFacts: {},
		});
		// biome-ignore lint/suspicious/noExplicitAny: partial store
		useWorkspaceStore.setState({ workspaces: [ws("a"), ws("b")] } as any);
		container = document.createElement("div");
		root = createRoot(container);
		await act(async () => root.render(<Harness />));
		sync.mockClear();
	});

	afterEach(() => {
		act(() => root.unmount());
	});

	it("re-runs the batched summary for every workspace when the Window gains focus", async () => {
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync).toHaveBeenCalledTimes(1);
		expect(sync.mock.calls[0][0].map((w: { id: string }) => w.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("does nothing on blur", async () => {
		await act(async () => {
			for (const l of focusListeners) l(false);
		});
		expect(sync).not.toHaveBeenCalled();
	});

	it("does not stack refreshes while one is in flight", async () => {
		let resolve: () => void = () => {};
		sync.mockImplementation(
			() =>
				new Promise<void>((r) => {
					resolve = r;
				}),
		);
		await act(async () => {
			for (const l of focusListeners) l(true);
			for (const l of focusListeners) l(true);
		});
		expect(sync).toHaveBeenCalledTimes(1);
		await act(async () => resolve());
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync).toHaveBeenCalledTimes(2);
	});

	it("unsubscribes on unmount", () => {
		expect(focusListeners).toHaveLength(1);
		act(() => root.unmount());
		expect(focusListeners).toHaveLength(0);
		root = createRoot(container);
	});
});
