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

function card() {
	const el = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!el) throw new Error("no dialog card");
	return el;
}

function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	act(() => {
		el.dispatchEvent(event);
	});
	return event;
}

describe("ParameterDialog Enter from every field (#201)", () => {
	const choiceAction = () =>
		makeAction("Review in {{mode}} mode", {
			mode: {
				type: "choice",
				options: ["quick", "deep"],
				defaultValue: "quick",
			},
		});

	it("focuses a choice field on open and submits it on Enter", () => {
		const onSubmit = render(choiceAction());
		const trigger = field("mode");
		expect(document.activeElement).toBe(trigger);

		const event = pressEnter(trigger);
		expect(event.defaultPrevented).toBe(true);
		expect(onSubmit).toHaveBeenCalledWith({ mode: "quick" }, false);
		expect(document.querySelector('[role="listbox"]')).toBeNull();
	});

	it("lets Enter in an open choice list pick, not submit", () => {
		const onSubmit = render(choiceAction());
		const trigger = field("mode");
		press(trigger, "ArrowDown");
		const list = document.querySelector<HTMLElement>('[role="listbox"]');
		expect(list).not.toBeNull();
		press(list as HTMLElement, "ArrowDown");
		pressEnter(list as HTMLElement);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.querySelector('[role="listbox"]')).toBeNull();

		pressEnter(field("mode"));
		expect(onSubmit).toHaveBeenCalledWith({ mode: "deep" }, false);
	});

	it("focuses a toggle on open and submits on Enter without flipping it", () => {
		const onSubmit = render(
			makeAction("Review{{strict}}", {
				strict: { type: "toggle", onText: " strictly", offText: "" },
			}),
		);
		const toggle = document.querySelector<HTMLElement>(
			"button[data-enter-submits]",
		);
		expect(toggle).not.toBeNull();
		expect(document.activeElement).toBe(toggle);

		const event = pressEnter(toggle as HTMLElement);
		expect(event.defaultPrevented).toBe(true);
		expect(onSubmit).toHaveBeenCalledWith({ strict: false }, false);
	});

	it("focuses the card for an attachment-first dialog; Enter points at Choose file", () => {
		const onSubmit = render(
			makeAction("Look at {{shot}}", { shot: { type: "attachment" } }),
		);
		expect(document.activeElement).toBe(card());

		pressEnter(card());
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement?.textContent).toContain("Choose file");
	});

	it("stages on Alt+Enter", () => {
		const onSubmit = render(choiceAction());
		pressEnter(field("mode"), { altKey: true });
		expect(onSubmit).toHaveBeenCalledWith({ mode: "quick" }, true);
	});

	it("moves focus to the first empty required field instead of submitting", () => {
		const onSubmit = render(
			makeAction("Review {{mode}} {{topic}}", {
				mode: { type: "choice", options: ["quick"], defaultValue: "quick" },
				topic: { type: "text" },
			}),
		);
		expect(document.activeElement).toBe(field("mode"));
		pressEnter(field("mode"));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(field("topic"));
	});

	it("leaves Enter on Cancel to the button itself", () => {
		const onSubmit = render(choiceAction());
		const cancel = [...document.querySelectorAll("button")].find(
			(b) => b.textContent === "Cancel",
		) as HTMLButtonElement;
		const event = pressEnter(cancel);
		expect(event.defaultPrevented).toBe(false);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("keeps the dialog open and shows a refusal from Enter", () => {
		const onSubmit = vi.fn((): string | null => "The agent is waiting");
		act(() => {
			root.render(
				<ParameterDialog
					action={choiceAction()}
					onSubmit={onSubmit}
					onCancel={vi.fn()}
				/>,
			);
		});
		pressEnter(field("mode"));
		expect(onSubmit).toHaveBeenCalled();
		expect(card().textContent).toContain("The agent is waiting");
	});

	it("does not let keys escape the dialog to the terminal", () => {
		render(choiceAction());
		const seen = vi.fn();
		document.addEventListener("keydown", seen);
		try {
			press(field("mode"), "a");
		} finally {
			document.removeEventListener("keydown", seen);
		}
		// React's synthetic stopPropagation stops the native event at the root.
		expect(seen).not.toHaveBeenCalled();
	});
});
