import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useJoinedStore } from "../../stores/joinedStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { HostChip } from "../HostChip";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const ws = (id: string, hostId?: string) =>
	({
		id,
		name: id,
		rootFolder: `/${id}`,
		tabs: [],
		...(hostId ? { joined: { hostId } } : {}),
	}) as unknown as WorkspaceWithTabs;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	useWorkspaceStore.setState({ workspaces: [ws("mine"), ws("theirs", "box")] });
	useJoinedStore.setState({
		entries: [
			{
				hostId: "box",
				hostName: "Build box",
				remoteProfileId: "r",
				remoteProfileName: "Build",
				lastSeenMs: null,
			},
		],
	});
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("HostChip (phase 10)", () => {
	it("names the Host of a joined Workspace's things", () => {
		act(() => root.render(<HostChip workspaceId="theirs" />));
		expect(container.textContent).toBe("Build box");
	});
	it("draws nothing for the Window's own", () => {
		act(() => root.render(<HostChip workspaceId="mine" />));
		expect(container.innerHTML).toBe("");
	});
});
