import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEscapeKey } from "../useEscapeKey";

function Overlay({ onEscape }: { onEscape: () => void }) {
	useEscapeKey(onEscape);
	return null;
}

function pressEscape() {
	act(() => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
	});
}

describe("useEscapeKey", () => {
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

	it("calls the handler on Escape", () => {
		const onEscape = vi.fn();
		act(() => root.render(<Overlay onEscape={onEscape} />));
		pressEscape();
		expect(onEscape).toHaveBeenCalledOnce();
	});

	it("ignores other keys", () => {
		const onEscape = vi.fn();
		act(() => root.render(<Overlay onEscape={onEscape} />));
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("gives Escape to the innermost overlay only", () => {
		// The case a per-dialog listener gets backwards: listeners on the same
		// node fire in registration order, and mount order is outermost-first, so
		// a naive implementation closes the dialog *behind* the one on top — and
		// stopPropagation cannot help, since it does not stop other listeners on
		// the same node.
		const outer = vi.fn();
		const inner = vi.fn();
		act(() =>
			root.render(
				<>
					<Overlay onEscape={outer} />
					<Overlay onEscape={inner} />
				</>,
			),
		);
		pressEscape();
		expect(inner).toHaveBeenCalledOnce();
		expect(outer).not.toHaveBeenCalled();
	});

	it("hands Escape back to the outer overlay once the inner one closes", () => {
		const outer = vi.fn();
		const inner = vi.fn();
		act(() =>
			root.render(
				<>
					<Overlay onEscape={outer} />
					<Overlay onEscape={inner} />
				</>,
			),
		);
		act(() => root.render(<Overlay onEscape={outer} />));
		pressEscape();
		expect(outer).toHaveBeenCalledOnce();
		expect(inner).not.toHaveBeenCalled();
	});

	it("stops reacting once every overlay has unmounted", () => {
		const onEscape = vi.fn();
		act(() => root.render(<Overlay onEscape={onEscape} />));
		act(() => root.render(<div />));
		pressEscape();
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("calls the latest handler, not the one from first render", () => {
		// The callback is read through a ref so an inline arrow does not re-order
		// the stack on every render. That must not leave a stale closure behind.
		const first = vi.fn();
		const second = vi.fn();
		act(() => root.render(<Overlay onEscape={first} />));
		act(() => root.render(<Overlay onEscape={second} />));
		pressEscape();
		expect(second).toHaveBeenCalledOnce();
		expect(first).not.toHaveBeenCalled();
	});
});
