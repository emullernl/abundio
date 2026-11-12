import { beforeEach, describe, expect, it, vi } from "vitest";

const handleCheck = vi.fn();
const handleDefault = vi.fn();
vi.mock("../../lib/ipc", () => ({
	agentControl: {
		handleCheck: (...a: unknown[]) => handleCheck(...a),
		handleDefault: (...a: unknown[]) => handleDefault(...a),
	},
	tabs: { update: async () => {} },
}));

import type { PaneNode, WorkspaceWithTabs } from "../../lib/types";
import type { PtyActivityEntry } from "../ptyActivityStore";
import { usePtyActivityStore } from "../ptyActivityStore";
import { useWorkspaceStore } from "../workspaceStore";

function setLayout(layout: PaneNode) {
	useWorkspaceStore.setState({
		workspaces: [
			{
				id: "ws",
				tabs: [
					{
						id: "t",
						workspaceId: "ws",
						name: "T",
						layoutJson: JSON.stringify(layout),
						position: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			} as unknown as WorkspaceWithTabs,
		],
	});
}

const node = () =>
	JSON.parse(useWorkspaceStore.getState().workspaces[0].tabs[0].layoutJson);

beforeEach(() => {
	handleCheck.mockReset().mockResolvedValue({ ok: true });
	handleDefault.mockReset().mockResolvedValue("Agent Two");
	usePtyActivityStore.setState({ panePtyMap: {}, activities: {} });
});

describe("ensureDefaultHandle", () => {
	it("names an Agent pane that has no handle", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(handleDefault).toHaveBeenCalledWith("ws", "a");
		expect(node().agentHandle).toBe("Agent Two");
	});

	it("names a pane in agent mode even before its Agent is stamped", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa" });
		usePtyActivityStore.setState({
			panePtyMap: { a: "pa" },
			activities: {
				pa: { state: "active", detectionMode: "agent" } as PtyActivityEntry,
			},
		});
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(node().agentHandle).toBe("Agent Two");
	});

	it("leaves a shell pane, and a named one, alone", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa" });
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		setLayout({
			type: "terminal",
			id: "a",
			ptyId: "pa",
			agentId: "claude",
			agentHandle: "Reviewer",
		});
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(handleDefault).not.toHaveBeenCalled();
		expect(node().agentHandle).toBe("Reviewer");
	});

	it("does not overwrite a name set while the default was being fetched", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		handleDefault.mockImplementation(async () => {
			setLayout({
				type: "terminal",
				id: "a",
				ptyId: "pa",
				agentId: "claude",
				agentHandle: "Mine",
			});
			return "Agent Two";
		});
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(node().agentHandle).toBe("Mine");
	});
});

describe("setAgentHandle", () => {
	it("refuses a handle Rust says is taken elsewhere in the Profile", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		handleCheck.mockResolvedValue({
			ok: false,
			code: "handle_taken",
			message: 'an Agent in the Workspace "api" is already called "Reviewer"',
		});
		const r = await useWorkspaceStore
			.getState()
			.setAgentHandle("a", "reviewer");
		expect(r).toMatchObject({ ok: false, code: "handle_taken" });
		expect(node().agentHandle).toBeUndefined();
	});

	it("stores the tidied name", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		await useWorkspaceStore.getState().setAgentHandle("a", "  Agent   Nine ");
		expect(handleCheck).toHaveBeenCalledWith("ws", "a", "Agent Nine");
		expect(node().agentHandle).toBe("Agent Nine");
	});

	it("clearing gives an Agent a default back", async () => {
		setLayout({
			type: "terminal",
			id: "a",
			ptyId: "pa",
			agentId: "claude",
			agentHandle: "Reviewer",
		});
		await useWorkspaceStore.getState().setAgentHandle("a", null);
		expect(node().agentHandle).toBe("Agent Two");
	});

	it("still works when Rust cannot be asked (the browser demo)", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		handleCheck.mockRejectedValue(new Error("no Tauri"));
		const r = await useWorkspaceStore.getState().setAgentHandle("a", "Solo");
		expect(r).toEqual({ ok: true });
		expect(node().agentHandle).toBe("Solo");
	});
});
