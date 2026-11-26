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
	handleDefault.mockReset().mockResolvedValue("Claude 2");
	usePtyActivityStore.setState({ panePtyMap: {}, activities: {} });
});

describe("ensureDefaultHandle", () => {
	it("names an Agent pane that has no handle", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(handleDefault).toHaveBeenCalledWith("ws", "a", "Claude");
		expect(node().agentHandle).toBe("Claude 2");
	});

	it("names a pane in agent mode even before its Agent is stamped", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa" });
		usePtyActivityStore.setState({
			panePtyMap: { a: "pa" },
			activities: {
				pa: { state: "active", detectionMode: "agent" } as PtyActivityEntry,
			},
		});
		handleDefault.mockResolvedValue("Agent 1");
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(handleDefault).toHaveBeenCalledWith("ws", "a", "Agent");
		expect(node().agentHandle).toBe("Agent 1");
	});

	it("renames an untouched Agent 1 once its Agent is known", async () => {
		setLayout({
			type: "terminal",
			id: "a",
			ptyId: "pa",
			agentHandle: "Agent 1",
		});
		handleDefault.mockResolvedValue("Codex 1");
		// Stamping the Agent is what asks for the new name.
		useWorkspaceStore.getState().stampAgentOnPane("a", "codex");
		await vi.waitFor(() => expect(node().agentHandle).toBe("Codex 1"));
		expect(handleDefault).toHaveBeenCalledWith("ws", "a", "Codex");
		expect(node().agentHandle).toBe("Codex 1");
	});

	it("lets the Agent's prefix win when an earlier Agent 1 lands first", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa" });
		usePtyActivityStore.setState({
			panePtyMap: { a: "pa" },
			activities: {
				pa: { state: "active", detectionMode: "agent" } as PtyActivityEntry,
			},
		});
		const replies: ((h: string) => void)[] = [];
		handleDefault.mockImplementation(
			() => new Promise<string>((r) => replies.push(r)),
		);
		// Entering agent mode asks for "Agent"; the stamp then asks for "Codex".
		const early = useWorkspaceStore.getState().ensureDefaultHandle("a");
		useWorkspaceStore.getState().stampAgentOnPane("a", "codex");
		await vi.waitFor(() => expect(replies).toHaveLength(2));
		expect(handleDefault).toHaveBeenNthCalledWith(1, "ws", "a", "Agent");
		expect(handleDefault).toHaveBeenNthCalledWith(2, "ws", "a", "Codex");
		replies[0]("Agent 1");
		await early;
		expect(node().agentHandle).toBe("Agent 1");
		replies[1]("Codex 1");
		await vi.waitFor(() => expect(node().agentHandle).toBe("Codex 1"));
	});

	it("does not let a late Agent 1 replace the Agent's own default", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "codex" });
		handleDefault.mockImplementation(async () => {
			setLayout({
				type: "terminal",
				id: "a",
				ptyId: "pa",
				agentId: "codex",
				agentHandle: "Codex 1",
			});
			return "Agent 1";
		});
		await useWorkspaceStore.getState().ensureDefaultHandle("a");
		expect(node().agentHandle).toBe("Codex 1");
	});

	it("keeps an older Agent One, and a typed-in name", async () => {
		for (const agentHandle of ["Agent One", "Agent Smith"]) {
			setLayout({
				type: "terminal",
				id: "a",
				ptyId: "pa",
				agentId: "claude",
				agentHandle,
			});
			await useWorkspaceStore.getState().ensureDefaultHandle("a");
			expect(node().agentHandle).toBe(agentHandle);
		}
		expect(handleDefault).not.toHaveBeenCalled();
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
			return "Claude 2";
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
		expect(node().agentHandle).toBe("Claude 2");
	});

	it("refuses the name when Rust cannot check it (the demo mocks the check)", async () => {
		setLayout({ type: "terminal", id: "a", ptyId: "pa", agentId: "claude" });
		handleCheck.mockRejectedValue(new Error("db"));
		const r = await useWorkspaceStore.getState().setAgentHandle("a", "Solo");
		expect(r).toMatchObject({ ok: false });
		expect(node().agentHandle).toBeUndefined();
	});
});
