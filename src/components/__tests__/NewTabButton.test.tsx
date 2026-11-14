import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appOverrideId } from "../../lib/keybindings";
import { useSettingsStore } from "../../stores/settingsStore";
import { NewTabButton } from "../TabBar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	useSettingsStore.setState({ keybindingOverrides: {} });
});

function render(onClick = () => {}, isDropTarget = false) {
	act(() =>
		root.render(<NewTabButton onClick={onClick} isDropTarget={isDropTarget} />),
	);
	const button = container.querySelector("button");
	if (!button) throw new Error("no button");
	return button;
}

describe("NewTabButton", () => {
	it("shows a Tab label and names itself for screen readers", () => {
		const button = render();
		expect(button.textContent).toBe("Tab");
		expect(button.getAttribute("aria-label")).toBe("New tab");
	});

	it("puts the New tab shortcut in its tooltip", () => {
		expect(render().title).toMatch(/^New tab \(.+\)$/);
	});

	it("shows no shortcut when New tab is Unbound", () => {
		useSettingsStore.setState({
			keybindingOverrides: { [appOverrideId("new-tab")]: null },
		});
		expect(render().title).toBe("New tab");
	});

	it("drops the hover classes and draws an outline while a pane hovers it", () => {
		const idle = render();
		expect(idle.className).toContain("hover:bg-[var(--bg-tertiary)]");
		expect(idle.style.outline).toBe("");

		const target = render(() => {}, true);
		expect(target.className).not.toContain("hover:");
		expect(target.style.outline).toContain("solid");
		expect(target.style.backgroundColor).not.toBe("");
	});

	it("opens a tab when clicked", () => {
		const onClick = vi.fn();
		const button = render(onClick);
		act(() => button.click());
		expect(onClick).toHaveBeenCalledOnce();
	});
});
