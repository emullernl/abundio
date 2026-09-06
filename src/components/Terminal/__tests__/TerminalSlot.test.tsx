import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePtyActivityStore } from "../../../stores/ptyActivityStore";

// The PTY whose ManagedTerminal getTerminal() returns for our pane. Tests reach
// in to flip which ptyId (or none) is reported so we can exercise the lookup.
let currentManagedPtyId: string | null = "pty-1";
// The xterm state the guards below read: whether the pane holds a selection and
// whether the foreground app is reporting the mouse.
let currentHasSelection = false;
let currentMouseTrackingMode = "none";

// Mock the heavy IO + child modules so the only thing rendered is TerminalSlot's
// own container div. We keep the real ptyActivityStore so clearWaiting actually
// runs and we can assert on the resulting state transition.
vi.mock("../../../lib/terminalManager", () => ({
	getTerminal: () =>
		currentManagedPtyId
			? {
					ptyId: currentManagedPtyId,
					ready: false,
					settled: false,
					term: {
						hasSelection: () => currentHasSelection,
						modes: { mouseTrackingMode: currentMouseTrackingMode },
					},
				}
			: null,
	resetTerminal: vi.fn(),
	getPaneRevision: () => 0,
	subscribePaneRevision: () => () => {},
}));
// Capture the element TerminalSlot registers as the xterm screen target
// (innerRef) so tests can dispatch clicks that land "inside the terminal" vs.
// on surrounding chrome.
const { registerTarget, xtermTargets } = vi.hoisted(() => {
	const xtermTargets: Record<string, HTMLElement> = {};
	return {
		xtermTargets,
		registerTarget: (paneId: string, el: HTMLElement) => {
			xtermTargets[paneId] = el;
		},
	};
});
vi.mock("../../../lib/portalRegistry", () => ({
	registerTarget,
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
		currentHasSelection = false;
		currentMouseTrackingMode = "none";
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

	// The registered xterm screen element — clicks here count as "inside the
	// terminal". Falls back to the pane container if registration didn't happen.
	function screenEl() {
		return xtermTargets["pane-1"] ?? paneEl();
	}

	function mouseDownOn(el: Element | null | undefined, button: number) {
		act(() => {
			el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button }));
		});
	}

	it("left-click inside the terminal screen drops a waiting agent to idle", () => {
		makeWaiting("pty-1");
		expect(stateOf("pty-1")).toBe("waiting");
		mouseDownOn(screenEl(), 0);
		expect(stateOf("pty-1")).toBe("idle");
	});

	it("left-click on pane chrome (outside the screen) leaves the dot lit", () => {
		makeWaiting("pty-1");
		// Click the outer container directly — stands in for the title bar / a
		// pane drag-reorder that starts outside the xterm screen.
		mouseDownOn(paneEl(), 0);
		expect(stateOf("pty-1")).toBe("waiting");
	});

	it("right-click inside the screen leaves the waiting dot untouched", () => {
		makeWaiting("pty-1");
		mouseDownOn(screenEl(), 2);
		expect(stateOf("pty-1")).toBe("waiting");
	});

	it("programmatic focus does not clear the waiting dot", () => {
		makeWaiting("pty-1");
		act(() => {
			paneEl()?.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
		});
		expect(stateOf("pty-1")).toBe("waiting");
	});

	it("survives a descendant that stops propagation (xterm mouse reporting)", () => {
		// The handler is bound in the capture phase precisely so xterm's own
		// mousedown listener — on a descendant, and ending in `cancel(ev)` when the
		// TUI has mouse reporting on — cannot suppress the only click path we have.
		// A bubble-phase binding would never see this event.
		makeWaiting("pty-1");
		const screen = screenEl();
		const swallow = (e: Event) => e.stopPropagation();
		screen?.addEventListener("mousedown", swallow);
		try {
			mouseDownOn(screen, 0);
			expect(stateOf("pty-1")).toBe("idle");
		} finally {
			screen?.removeEventListener("mousedown", swallow);
		}
	});

	it("is a no-op when the pane has no managed PTY yet", () => {
		makeWaiting("pty-1");
		currentManagedPtyId = null;
		mouseDownOn(screenEl(), 0);
		expect(stateOf("pty-1")).toBe("waiting");
	});
});

// A TUI that turns on mouse tracking (DECSET 1000/1002/1003 — the GitHub
// Copilot CLI does) makes xterm forward mouse events to the PTY as reports, and
// every report counts as user input, which clears the terminal selection. These
// guards keep the right button and (while a selection is up) pointer movement
// away from xterm's own listeners, which sit on a descendant of the pane
// container. The stand-in below plays xterm's part: it must not be reached.
describe("TerminalSlot — mouse events withheld from a mouse-reporting app", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let reachedXterm: string[];

	beforeEach(() => {
		currentManagedPtyId = "pty-1";
		currentHasSelection = false;
		currentMouseTrackingMode = "any";
		reachedXterm = [];
		usePtyActivityStore.setState({ activities: {}, panePtyMap: {} });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		act(() => {
			root.render(
				<TerminalSlot
					paneId="pane-2"
					isFocused={false}
					onFocus={() => {}}
					onSplitHorizontal={() => {}}
					onSplitVertical={() => {}}
					onClose={() => {}}
				/>,
			);
		});
		// xterm's listeners live on `.xterm`, a descendant of the pane container.
		const screen = xtermTargets["pane-2"];
		screen?.addEventListener("mousedown", (e) =>
			reachedXterm.push(`mousedown:${(e as MouseEvent).button}`),
		);
		screen?.addEventListener("mousemove", () => reachedXterm.push("mousemove"));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function dispatch(type: string, init: MouseEventInit) {
		act(() => {
			xtermTargets["pane-2"]?.dispatchEvent(
				new MouseEvent(type, { bubbles: true, ...init }),
			);
		});
	}

	it("does not deliver a right mousedown to xterm", () => {
		dispatch("mousedown", { button: 2, buttons: 2 });
		expect(reachedXterm).toEqual([]);
	});

	it("still delivers a left mousedown to xterm", () => {
		dispatch("mousedown", { button: 0, buttons: 1 });
		expect(reachedXterm).toEqual(["mousedown:0"]);
	});

	it("delivers pointer movement while there is no selection", () => {
		dispatch("mousemove", { buttons: 0 });
		expect(reachedXterm).toEqual(["mousemove"]);
	});

	it("withholds pointer movement while the pane holds a selection", () => {
		currentHasSelection = true;
		dispatch("mousemove", { buttons: 0 });
		expect(reachedXterm).toEqual([]);
	});

	it("never withholds movement with a button held, so a drag still extends", () => {
		currentHasSelection = true;
		dispatch("mousemove", { buttons: 1 });
		expect(reachedXterm).toEqual(["mousemove"]);
	});
});
