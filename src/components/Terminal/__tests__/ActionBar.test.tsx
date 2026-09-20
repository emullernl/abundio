/**
 * Action bar rendering rules.
 *
 * These cover the *decisions the component makes about what to draw*. The one
 * rule they deliberately do NOT prove is the Waiting guard's real behaviour:
 * asserting that a button is disabled when the store says `waiting` shows the
 * component reads a flag, not that the flag is set when an Agent is actually
 * asking for permission. That needs the running app — see the Testing section
 * of docs/plans/prompt-actions.md and the Debug palette entries that make it
 * cheap to reproduce.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/ipc", () => ({
	promptActions: {
		list: vi.fn().mockResolvedValue([]),
		create: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
		reorder: vi.fn(),
		onChanged: vi.fn().mockResolvedValue(() => {}),
	},
	promptAttachments: { save: vi.fn() },
}));
vi.mock("../../../lib/firePromptAction", () => ({
	firePromptAction: vi.fn(),
	isAgentPane: vi.fn(),
}));

import type { PromptAction } from "../../../lib/promptActions";
import { usePromptActionStore } from "../../../stores/promptActionStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { ActionBar } from "../ActionBar";

const PANE = "pane-1";
const PTY = "pty-1";

function action(over: Partial<PromptAction> = {}): PromptAction {
	return {
		id: "a1",
		name: "Review",
		body: "/review",
		scope: { kind: "all" },
		params: {},
		showInBar: true,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

/** Put the pane's PTY into agent mode with the given state and agent id. */
function setPane(opts: {
	agentMode?: boolean;
	state?: "idle" | "waiting" | "active";
	agentId?: string;
}) {
	const { agentMode = true, state = "idle", agentId } = opts;
	usePtyActivityStore.setState({
		panePtyMap: { [PANE]: PTY },
		activities: {
			[PTY]: {
				detectionMode: agentMode ? "agent" : "shell",
				state,
			},
			// The bar reads only these two fields; the rest of the activity record
			// is irrelevant to what it draws.
		} as unknown as ReturnType<
			typeof usePtyActivityStore.getState
		>["activities"],
		detectedAgentIds: agentId ? { [PTY]: agentId } : {},
	});
}

describe("ActionBar", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		useSettingsStore.setState({ showActionBar: true });
		usePromptActionStore.setState({ actions: [], loaded: true, error: null });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(onRequestParams = vi.fn(), onAddAction = vi.fn()) {
		act(() => {
			root.render(
				<ActionBar
					paneId={PANE}
					onRequestParams={onRequestParams}
					onAddAction={onAddAction}
				/>,
			);
		});
	}

	it("renders nothing when no action is in scope", () => {
		// Not an empty bar — no bar. A feature the user has not adopted costs
		// them no terminal rows.
		setPane({});
		render();
		expect(container.textContent).toBe("");
		expect(container.querySelector("button")).toBeNull();
	});

	it("renders nothing in a shell pane", () => {
		setPane({ agentMode: false });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		expect(container.querySelector("button")).toBeNull();
	});

	it("renders nothing while the first load is still in flight", () => {
		// Otherwise a cold start flashes a bar in and back out.
		setPane({});
		usePromptActionStore.setState({ actions: [action()], loaded: false });
		render();
		expect(container.querySelector("button")).toBeNull();
	});

	it("renders nothing when the global toggle is off", () => {
		setPane({});
		usePromptActionStore.setState({ actions: [action()] });
		useSettingsStore.setState({ showActionBar: false });
		render();
		expect(container.querySelector("button")).toBeNull();
	});

	it("shows global actions while the agent id is unresolved", () => {
		// The auto-launch path marks a PTY as an Agent knowing only the command
		// string; the id is backfilled later. A usable bar beats no bar.
		setPane({ agentId: undefined });
		usePromptActionStore.setState({
			actions: [
				action({ id: "g", name: "Global" }),
				action({
					id: "s",
					name: "Scoped",
					scope: { kind: "set", agentIds: ["claude-code"] },
				}),
			],
		});
		render();
		expect(container.textContent).toContain("Global");
		expect(container.textContent).not.toContain("Scoped");
	});

	it("puts agent-scoped actions first, so they take the low digits", () => {
		setPane({ agentId: "claude-code" });
		usePromptActionStore.setState({
			actions: [
				action({ id: "g", name: "Global", position: 0 }),
				action({
					id: "s",
					name: "Scoped",
					position: 1,
					scope: { kind: "set", agentIds: ["claude-code"] },
				}),
			],
		});
		render();
		const labels = [...container.querySelectorAll("button")]
			.map((b) => b.textContent ?? "")
			.filter((t) => t.includes("Scoped") || t.includes("Global"));
		expect(labels[0]).toContain("Scoped");
		expect(labels[0]).toContain("1");
		expect(labels[1]).toContain("Global");
		expect(labels[1]).toContain("2");
	});

	it("never offers an action whose scope set has emptied out", () => {
		// Its only Agent was deleted. Kept in Settings, never rendered here.
		setPane({ agentId: "claude-code" });
		usePromptActionStore.setState({
			actions: [action({ scope: { kind: "set", agentIds: [] } })],
		});
		render();
		expect(container.querySelector("button")).toBeNull();
	});

	it("honours Show in bar", () => {
		setPane({ agentId: "claude-code" });
		usePromptActionStore.setState({
			actions: [action({ name: "Hidden", showInBar: false })],
		});
		render();
		expect(container.textContent).not.toContain("Hidden");
	});

	it("marks a parameterised action with a trailing ellipsis", () => {
		// The macOS menu convention. It matters here because a plain click
		// otherwise submits straight to the agent.
		setPane({ agentId: "claude-code" });
		usePromptActionStore.setState({
			actions: [action({ name: "Explain", body: "Explain {{symbol}}" })],
		});
		render();
		expect(container.textContent).toContain("Explain…");
	});

	it("numbers only the first nine buttons", () => {
		setPane({ agentId: "claude-code" });
		usePromptActionStore.setState({
			actions: Array.from({ length: 11 }, (_, i) =>
				action({ id: `a${i}`, name: `Act${i}`, position: i }),
			),
		});
		render();
		const tenth = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Act9"),
		);
		// "Act9" is the tenth button (index 9) — past the numbered range.
		expect(tenth?.textContent).toBe("Act9");
	});

	it("disables every button while the agent is Waiting", () => {
		setPane({ agentId: "claude-code", state: "waiting" });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		const btn = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Review"),
		);
		expect(btn?.disabled).toBe(true);
	});

	it("leaves buttons live while the agent is Working", () => {
		// Queuing a follow-up mid-turn is a real workflow.
		setPane({ agentId: "claude-code", state: "active" });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		const btn = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Review"),
		);
		expect(btn?.disabled).toBe(false);
	});

	it("asks for parameters instead of firing when the action has any", () => {
		const onRequestParams = vi.fn();
		setPane({ agentId: "claude-code" });
		const a = action({ name: "Explain", body: "Explain {{symbol}}" });
		usePromptActionStore.setState({ actions: [a] });
		render(onRequestParams);
		const btn = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Explain"),
		);
		act(() => {
			btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(onRequestParams).toHaveBeenCalledWith(a);
	});
});
