import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/ipc", () => ({
	promptAttachments: { fromClipboard: vi.fn() },
}));

import type { ParamMetaMap, PromptAction } from "../../../lib/promptActions";
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

function makeAction(body: string, params: ParamMetaMap = {}): PromptAction {
	return {
		id: "a1",
		name: "Explain",
		body,
		scope: { kind: "all" },
		params,
		showInBar: true,
		position: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function render(action: PromptAction) {
	const onSubmit = vi.fn((): string | null => null);
	act(() => {
		root.render(
			<ParameterDialog
				action={action}
				onSubmit={onSubmit}
				onCancel={vi.fn()}
			/>,
		);
	});
	return onSubmit;
}

function field(name: string) {
	const el = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
	if (!el) throw new Error(`no field named ${name}`);
	return el;
}

// Simulates the value change a Shift+Enter produces, not the keystroke:
// jsdom performs no default action for keydown, so dispatching the key
// would insert nothing and prove nothing.
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

function pressEnter(el: HTMLElement, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key: "Enter",
		bubbles: true,
		cancelable: true,
		...init,
	});
	act(() => {
		el.dispatchEvent(event);
	});
	return event;
}

describe("ParameterDialog text field", () => {
	it("keeps the same focused element when the value gains a newline", () => {
		const onSubmit = render(makeAction("Explain {{topic}}"));
		const el = field("topic");
		expect(el).toBeInstanceOf(HTMLTextAreaElement);
		expect(document.activeElement).toBe(el);

		typeInto(el as HTMLTextAreaElement, "one\ntwo");

		// Regression: an <input> used to be swapped for a <textarea> here,
		// remounting the element and dropping focus.
		expect(field("topic")).toBe(el);
		expect(document.activeElement).toBe(el);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("selects the authored default on open", () => {
		render(
			makeAction("Explain {{topic}}", {
				topic: { type: "text", defaultValue: "foo" },
			}),
		);
		const el = field("topic") as HTMLTextAreaElement;
		expect(el.selectionStart).toBe(0);
		expect(el.selectionEnd).toBe(3);
	});

	it("submits on Enter instead of inserting a newline", () => {
		const onSubmit = render(
			makeAction("Explain {{topic}}", {
				topic: { type: "text", defaultValue: "foo" },
			}),
		);
		const event = pressEnter(field("topic"));
		expect(event.defaultPrevented).toBe(true);
		expect(onSubmit).toHaveBeenCalledWith({ topic: "foo" }, false);
	});

	it("does not submit on the Enter that commits an IME candidate", () => {
		const onSubmit = render(
			makeAction("Explain {{topic}}", {
				topic: { type: "text", defaultValue: "foo" },
			}),
		);
		const event = pressEnter(field("topic"), { isComposing: true });
		expect(event.defaultPrevented).toBe(false);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("leaves Shift+Enter to the textarea's own newline", () => {
		const onSubmit = render(
			makeAction("Explain {{topic}}", {
				topic: { type: "text", defaultValue: "foo" },
			}),
		);
		const event = pressEnter(field("topic"), { shiftKey: true });
		expect(event.defaultPrevented).toBe(false);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

describe("ParameterDialog number field", () => {
	it("stays an input and swallows Shift+Enter", () => {
		const onSubmit = render(
			makeAction("Retry {{count}} times", {
				count: { type: "number", defaultValue: "3" },
			}),
		);
		const el = field("count");
		expect(el).toBeInstanceOf(HTMLInputElement);
		expect((el as HTMLInputElement).type).toBe("number");

		const event = pressEnter(el, { shiftKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(onSubmit).not.toHaveBeenCalled();
		expect((el as HTMLInputElement).value).toBe("3");
	});
});
