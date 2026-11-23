import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
	sendNotification: vi.fn(),
	onAction: vi.fn(),
}));

import type { WorkspaceWithTabs } from "../../types";
import { collectPaneFacts, diffPaneFacts } from "../paneFactsSync";

const ws = {
	id: "w",
	tabs: [
		{
			id: "t",
			name: "Tab 1",
			position: 0,
			layoutJson: JSON.stringify({
				type: "split",
				id: "s",
				direction: "vertical",
				ratio: 0.5,
				first: { type: "terminal", id: "a", ptyId: "pty-a" },
				second: { type: "terminal", id: "b", ptyId: "" },
			}),
		},
	],
} as unknown as WorkspaceWithTabs;

const sources = {
	workspaces: [ws],
	panePtyMap: { b: "pty-b" },
	titles: { a: "zsh" },
	cwds: { "pty-a": "/x" },
	runningCommands: { "pty-a": "make" },
	detectedAgentIds: { "pty-b": "claude" },
	progress: { b: "2/3" },
	integrationSeen: new Set(["a"]),
};

describe("pane facts for Rust", () => {
	it("gathers each pane's facts, by pane or by its PTY", () => {
		const facts = collectPaneFacts(sources);
		expect(facts.get("a")).toEqual({
			title: "zsh",
			cwd: "/x",
			command: "make",
			detectedAgentId: null,
			progress: null,
			shellIntegrationSeen: true,
		});
		// The PTY a pane runs now, even before the layout names it.
		expect(facts.get("b")).toMatchObject({
			detectedAgentId: "claude",
			progress: "2/3",
		});
	});

	it("reports only what changed, and panes that are gone", () => {
		const before = collectPaneFacts(sources);
		expect(diffPaneFacts(before, before)).toEqual([]);
		const after = collectPaneFacts({ ...sources, titles: { a: "vim" } });
		expect(diffPaneFacts(before, after)).toEqual([
			{ paneId: "a", facts: expect.objectContaining({ title: "vim" }) },
		]);
		const gone = new Map(after);
		gone.delete("b");
		expect(diffPaneFacts(after, gone)).toEqual([{ paneId: "b", facts: null }]);
	});
});
