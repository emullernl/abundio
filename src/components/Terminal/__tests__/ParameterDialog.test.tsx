import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/ipc", () => ({
	promptAttachments: { fromClipboard: vi.fn() },
}));

import type { PromptAction } from "../../../lib/promptActions";
import { ParameterDialog } from "../ParameterDialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const action: PromptAction = {
	id: "a1",
	name: "Explain",
	body: "Explain {{topic}}",
	scope: { kind: "all" },
	params: {},
	showInBar: true,
	position: 0,
	createdAt: 0,
	updatedAt: 0,
};

function typeInto(el: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("ParameterDialog text field", () => {
	it("keeps the same focused element when the value gains a newline", () => {
		const onSubmit = vi.fn(() => null);
		act(() => {
			root.render(
				<ParameterDialog
					action={action}
					onSubmit={onSubmit}
					onCancel={vi.fn()}
				/>,
			);
		});
		const field = document.querySelector("textarea");
		expect(field).not.toBeNull();
		expect(document.activeElement).toBe(field);

		typeInto(field as HTMLTextAreaElement, "one\ntwo");

		// Regression: an <input> used to be swapped for a <textarea> here,
		// remounting the element and dropping focus.
		expect(document.querySelector("textarea")).toBe(field);
		expect(document.activeElement).toBe(field);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
