import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";

// The PTY whose ManagedTerminal getTerminal() returns for our pane. Tests reach
// in to flip which ptyId (or none) is reported so we can exercise the lookup.
let currentManagedPtyId: string | null = "pty-1";

// Mock the heavy IO + child modules so the only thing rendered is TerminalSlot's
// own container div. We keep the real ptyActivityStore so clearWaiting actually
// runs and we can assert on the resulting state transition.
vi.mock("../../../lib/terminalManager", () => ({
	getTerminal: () =>
		currentManagedPtyId
			? { ptyId: currentManagedPtyId, ready: false, settled: false }
			: null,
	resetTerminal: vi.fn(),
	getPaneRevision: () => 0,
	subscribePaneRevision: () => () => {},
}));
vi.mock("../../../lib/portalRegistry", () => ({
	registerTarget: vi.fn(),
	unregisterTarget: vi.fn(),
}));
vi.mock("../../../lib/ipc", () => ({ pty: { write: vi.fn() } }));
vi.mock("../../../lib/terminalClipboard", () => ({
	copyTerminalSelection: vi.fn(),
	pasteIntoTerminal: vi.fn(),
}));
vi.mock("../../../lib/agentIcons", () => ({
	FallbackAgentIcon: () => null,
	getAgentIconComponent: () => null,
}));
vi.mock("../TerminalTitleBar", () => ({ TerminalTitleBar: () => null }));
vi.mock("./DebugActivityMeter", () => ({ DebugActivityMeter: () => null }));
vi.mock("../SearchBar", () => ({ SearchBar: () => null }));
vi.mock("../PaneContextMenu", () => ({ PaneContextMenu: () => null }));
vi.mock("../../PaneDropIndicator", () => ({ PaneDropIndicator: () => null }));
vi.mock("../../FileDropHighlight", () => ({ FileDropHighlight: () => null }));

// Imported after the mocks above are registered.
import { TerminalSlot } from "../TerminalSlot";

function makeWaiting(ptyId: string) {
	const { initPty, setAgentPty, applyHookEvent } =
		usePtyActivityStore.getState();
	initPty(ptyId);
	setAgentPty(ptyId);
	applyHookEvent(ptyId, "waiting");
}

function stateOf(ptyId: string) {
	return usePtyActivityStore.getState().activities[ptyId]?.state;
}

describe("TerminalSlot — click clears a waiting agent", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		currentManagedPtyId = "pty-1";
		usePtyActivityStore.setState({ activities: {}, panePtyMap: {} });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(
				<TerminalSlot
					paneId="pane-1"
					isFocused={false}
					onFocus={() => {}}
					onSplitHorizontal={() => {}}
					onSplitVertical={() => {}}
					onClose={() => {}}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function paneEl() {
		return container.querySelector<HTMLElement>('[data-pane-id="pane-1"]');
	}

	function mouseDown(button: number) {
		act(() => {
			paneEl()?.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, button }),
			);
		});
	}

	it("left-click drops a waiting agent to idle", () => {
		makeWaiting("pty-1");
		expect(stateOf("pty-1")).toBe("waiting");
		mouseDown(0);
		expect(stateOf("pty-1")).toBe("idle");
	});

	it("right-click leaves the waiting dot untouched", () => {
		makeWaiting("pty-1");
		mouseDown(2);
		expect(stateOf("pty-1")).toBe("waiting");
	});

	it("programmatic focus does not clear the waiting dot", () => {
		makeWaiting("pty-1");
		act(() => {
			paneEl()?.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
		});
		expect(stateOf("pty-1")).toBe("waiting");
	});

	it("is a no-op when the pane has no managed PTY yet", () => {
		makeWaiting("pty-1");
		currentManagedPtyId = null;
		mouseDown(0);
		expect(stateOf("pty-1")).toBe("waiting");
	});
});
