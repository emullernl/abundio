import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});

function render(onClick = () => {}) {
	act(() => root.render(<NewTabButton onClick={onClick} />));
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
		expect(render().title).toMatch(/^New tab .+/);
	});

	it("opens a tab when clicked", () => {
		const onClick = vi.fn();
		const button = render(onClick);
		act(() => button.click());
		expect(onClick).toHaveBeenCalledOnce();
	});
});
