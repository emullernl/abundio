import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitChangedFile } from "../../../lib/types";
import { GitChangesFileItem } from "../GitChangesFileItem";

const FILE: GitChangedFile = {
	path: "src/lib/gitRowMenu.ts",
	section: "unstaged",
	status: "M",
	additions: 3,
	deletions: 1,
};

describe("GitChangesFileItem — Row menu trigger", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderRow(
		props: Partial<Parameters<typeof GitChangesFileItem>[0]> = {},
	) {
		const onContextMenu = vi.fn();
		const onClick = vi.fn();
		act(() => {
			root.render(
				<GitChangesFileItem
					file={FILE}
					isSelected={false}
					isMenuTarget={false}
					onClick={onClick}
					onOpenFile={vi.fn()}
					onContextMenu={onContextMenu}
					{...props}
				/>,
			);
		});
		const row = container.querySelector('[role="button"]') as HTMLElement;
		return { row, onContextMenu, onClick };
	}

	it("opens the menu at the pointer on right-click", () => {
		const { row, onContextMenu } = renderRow();
		act(() => {
			row.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					clientX: 120,
					clientY: 340,
				}),
			);
		});
		expect(onContextMenu).toHaveBeenCalledWith(120, 340);
	});

	it("does not select the row — that would open a pane", () => {
		const { row, onClick } = renderRow();
		act(() => {
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
		});
		expect(onClick).not.toHaveBeenCalled();
	});

	it.each([
		"ContextMenu",
		"F10",
	])("opens the menu from the keyboard (%s)", (key) => {
		const { row, onContextMenu } = renderRow();
		act(() => {
			row.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					shiftKey: key === "F10",
					bubbles: true,
				}),
			);
		});
		expect(onContextMenu).toHaveBeenCalledTimes(1);
	});

	it("ignores a bare F10", () => {
		const { row, onContextMenu } = renderRow();
		act(() => {
			row.dispatchEvent(
				new KeyboardEvent("keydown", { key: "F10", bubbles: true }),
			);
		});
		expect(onContextMenu).not.toHaveBeenCalled();
	});

	it("rings the menu target instead of filling it like a selection", () => {
		const { row } = renderRow({ isMenuTarget: true });
		expect(row.style.boxShadow).toContain("inset");
		expect(row.style.backgroundColor).toBe("transparent");
	});
});
