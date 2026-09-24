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
	promptAttachments: { fromClipboard: vi.fn() },
}));
vi.mock("../../../lib/firePromptAction", () => ({
	firePromptAction: vi.fn(),
	isAgentPane: vi.fn(),
}));

import type { PromptAction } from "../../../lib/promptActions";
import { usePromptActionStore } from "../../../stores/promptActionStore";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { ActionBar, barMetrics } from "../ActionBar";

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

	it("still renders, with an invitation, when no action is in scope", () => {
		// The bar is present in every agent pane. Nothing is seeded on a fresh
		// install, so an absent bar would leave the feature with no visible way
		// in at all.
		setPane({});
		render();
		expect(container.textContent).toContain("Add a prompt action");
	});

	it("drops the trailing + while empty, so there is only one way in", () => {
		setPane({});
		render();
		expect(
			container.querySelector('button[aria-label="Add prompt action"]'),
		).toBeNull();
	});

	it("shows the trailing + once there is something in the bar", () => {
		setPane({ agentId: "claude" });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		expect(
			container.querySelector('button[aria-label="Add prompt action"]'),
		).not.toBeNull();
		expect(container.textContent).not.toContain("Add a prompt action");
	});

	it("renders nothing in a shell pane", () => {
		// A prompt has nothing to talk to in a bare shell.
		setPane({ agentMode: false });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		expect(container.querySelector("button")).toBeNull();
	});

	it("withholds the invitation while the first load is in flight", () => {
		// The bar itself is there either way; only its empty-state copy waits,
		// so a cold start does not show "Add a prompt action" for a frame before
		// the real buttons arrive.
		setPane({});
		usePromptActionStore.setState({ actions: [action()], loaded: false });
		render();
		expect(container.textContent).not.toContain("Add a prompt action");
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
					scope: { kind: "set", agentIds: ["claude"] },
				}),
			],
		});
		render();
		expect(container.textContent).toContain("Global");
		expect(container.textContent).not.toContain("Scoped");
	});

	it("puts agent-scoped actions first, so they take the low digits", () => {
		setPane({ agentId: "claude" });
		usePromptActionStore.setState({
			actions: [
				action({ id: "g", name: "Global", position: 0 }),
				action({
					id: "s",
					name: "Scoped",
					position: 1,
					scope: { kind: "set", agentIds: ["claude"] },
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
		// Its only Agent was deleted. Kept in Settings, never rendered here —
		// the bar falls back to its empty state.
		setPane({ agentId: "claude" });
		usePromptActionStore.setState({
			actions: [action({ scope: { kind: "set", agentIds: [] } })],
		});
		render();
		expect(container.textContent).toContain("Add a prompt action");
		expect(container.textContent).not.toContain("Review");
	});

	it("honours Show in bar", () => {
		setPane({ agentId: "claude" });
		usePromptActionStore.setState({
			actions: [action({ name: "Hidden", showInBar: false })],
		});
		render();
		expect(container.textContent).not.toContain("Hidden");
	});

	it("marks a parameterised action with a trailing ellipsis", () => {
		// The macOS menu convention. It matters here because a plain click
		// otherwise submits straight to the agent.
		setPane({ agentId: "claude" });
		usePromptActionStore.setState({
			actions: [action({ name: "Explain", body: "Explain {{symbol}}" })],
		});
		render();
		expect(container.textContent).toContain("Explain…");
	});

	it("numbers only the first nine buttons", () => {
		setPane({ agentId: "claude" });
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
		setPane({ agentId: "claude", state: "waiting" });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		const btn = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Review"),
		);
		expect(btn?.disabled).toBe(true);
	});

	it("leaves buttons live while the agent is Working", () => {
		// Queuing a follow-up mid-turn is a real workflow.
		setPane({ agentId: "claude", state: "active" });
		usePromptActionStore.setState({ actions: [action()] });
		render();
		const btn = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Review"),
		);
		expect(btn?.disabled).toBe(false);
	});

	it("asks for parameters instead of firing when the action has any", () => {
		const onRequestParams = vi.fn();
		setPane({ agentId: "claude" });
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

// The bar follows the pane's terminal font — including the Fleet Console's
// Tile zoom — rather than a fixed 11px.
describe("barMetrics", () => {
	it("matches the reference design at 14px", () => {
		expect(barMetrics(14)).toMatchObject({ height: 24, text: 11, pad: 10 });
	});

	it("scales with the font", () => {
		const big = barMetrics(21);
		expect(big.height).toBe(36);
		expect(big.text).toBe(16.5);
		const zoomed = barMetrics(10.5);
		expect(zoomed.height).toBe(18);
		expect(zoomed.text).toBe(8.5);
	});

	it("never shrinks below a usable size", () => {
		const tiny = barMetrics(6);
		expect(tiny.height).toBe(16);
		expect(tiny.text).toBe(8);
	});
});
