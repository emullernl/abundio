import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ContextMenuItem, PaneContextMenu } from "../PaneContextMenu";

const ITEMS: ContextMenuItem[] = [
	{ label: "Open Diff", disabled: true },
	{ label: "Open File" },
	{ separator: true },
	{ label: "Copy Relative Path" },
];

describe("PaneContextMenu — keyboard focus", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let opener: HTMLButtonElement;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		root = createRoot(container);
	});

	afterEach(() => {
		container.remove();
		opener.remove();
	});

	function render(autoFocus: boolean) {
		act(() => {
			root.render(
				<PaneContextMenu
					x={0}
					y={0}
					items={ITEMS}
					autoFocus={autoFocus}
					onClose={vi.fn()}
				/>,
			);
		});
	}

	it("leaves focus alone when opened with a pointer", () => {
		render(false);
		expect(document.activeElement).toBe(opener);
		act(() => root.unmount());
	});

	it("focuses the first item the user can act on", () => {
		// Not the leading disabled one — that would leave the menu looking inert.
		render(true);
		expect((document.activeElement as HTMLElement).textContent).toBe(
			"Open File",
		);
		act(() => root.unmount());
	});

	it("hands focus back to the opener on close", () => {
		render(true);
		expect(document.activeElement).not.toBe(opener);
		act(() => root.unmount());
		expect(document.activeElement).toBe(opener);
	});
});
