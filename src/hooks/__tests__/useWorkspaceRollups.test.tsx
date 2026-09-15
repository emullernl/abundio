import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import {
	type PtyActivityEntry,
	usePtyActivityStore,
	type WorkspaceRollups,
} from "../../stores/ptyActivityStore";
import { useWorkspaceRollups } from "../useWorkspaceRollups";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE: WorkspaceWithTabs = {
	id: "ws-1",
	name: "acme",
	rootFolder: "/repo/acme",
	agentPresetsJson: "{}",
	fileTabsJson: "[]",
	baseBranch: null,
	lastBranch: null,
	position: 0,
	profileId: "p1",
	createdAt: 0,
	updatedAt: 0,
	worktreeSetupCommands: "",
	tabs: [
		{
			id: "tab-1",
			workspaceId: "ws-1",
			name: "Tab",
			layoutJson: JSON.stringify({ type: "terminal", id: "p1", ptyId: "own" }),
			position: 0,
			createdAt: 0,
			updatedAt: 0,
		},
	],
};

function entry(
	state: PtyActivityEntry["state"],
	detectionMode: "agent" | "shell",
): PtyActivityEntry {
	return {
		state,
		lastOutputAt: null,
		hasEverReceivedOutput: true,
		detectionMode,
		hookDriven: false,
	};
}

// The hook subscribes through an encoded string key precisely so that a
// status change in some *other* pane does not re-render every sidebar row.
// A refactor to an object selector would look equivalent and silently lose
// that — this pins it.
describe("useWorkspaceRollups re-renders", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders: number;
	let last: WorkspaceRollups | undefined;

	function Probe() {
		renders++;
		last = useWorkspaceRollups(WORKSPACE);
		return null;
	}

	const setActivities = (activities: Record<string, PtyActivityEntry>) =>
		act(() => {
			usePtyActivityStore.setState({ activities });
		});

	beforeEach(() => {
		renders = 0;
		last = undefined;
		usePtyActivityStore.setState({
			activities: { own: entry("idle", "agent") },
			panePtyMap: {},
			openedWorkspaceIds: new Set(["ws-1"]),
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => root.render(<Probe />));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("does not re-render when an unrelated PTY's status changes", () => {
		expect(renders).toBe(1);
		setActivities({
			own: entry("idle", "agent"),
			other: entry("active", "agent"),
		});
		setActivities({
			own: entry("idle", "agent"),
			other: entry("error", "shell"),
		});
		expect(renders).toBe(1);
	});

	it("keeps the same rollups object while nothing it covers changed", () => {
		const before = last;
		setActivities({
			own: entry("idle", "agent"),
			other: entry("active", "agent"),
		});
		expect(last).toBe(before);
	});

	it("re-renders when one of its own PTYs changes state", () => {
		setActivities({ own: entry("waiting", "agent") });
		expect(renders).toBe(2);
		expect(last?.agent?.status).toBe("skyblue");
		expect(last?.agent?.counts.waiting).toBe(1);
	});
});
