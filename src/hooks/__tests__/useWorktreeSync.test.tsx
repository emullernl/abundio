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
			uncommittedById: {},
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

	it("asks only about workspaces with no live answer", async () => {
		// A live breakdown means a scheduler is pushing this workspace's
		// dirtiness; asking the batch about it would scan a large repository and
		// then discard the answer.
		useWorkspaceGitStore.setState({
			uncommittedById: {
				a: {
					dirty: true,
					breakdown: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
				},
				b: { dirty: false, breakdown: null },
			},
		});
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync.mock.calls[0][0].map((w: { id: string }) => w.id)).toEqual([
			"b",
		]);
	});

	it("does not call out at all when every workspace is live", async () => {
		useWorkspaceGitStore.setState({
			uncommittedById: {
				a: {
					dirty: false,
					breakdown: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
				},
				b: {
					dirty: false,
					breakdown: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
				},
			},
		});
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync).not.toHaveBeenCalled();
	});

	it("rate-limits repeated focus transitions", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		// Flicking away and back moments later costs nothing.
		vi.setSystemTime(1_002_000);
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync).toHaveBeenCalledTimes(1);
		// Coming back after real work elsewhere refreshes.
		vi.setSystemTime(1_020_000);
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("does nothing on blur", async () => {
		await act(async () => {
			for (const l of focusListeners) l(false);
		});
		expect(sync).not.toHaveBeenCalled();
	});

	it("does not stack refreshes while one is in flight", async () => {
		vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
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
		// Past the cooldown, so only the in-flight guard can be under test here.
		vi.setSystemTime(1_060_000);
		await act(async () => {
			for (const l of focusListeners) l(true);
		});
		expect(sync).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("unsubscribes on unmount", () => {
		expect(focusListeners).toHaveLength(1);
		act(() => root.unmount());
		expect(focusListeners).toHaveLength(0);
		root = createRoot(container);
	});
});
