import type { SearchAddon } from "@xterm/addon-search";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "../SearchBar";

function mockSearchAddon() {
	return {
		findNext: vi.fn(),
		findPrevious: vi.fn(),
		clearDecorations: vi.fn(),
	} as unknown as SearchAddon & {
		findNext: ReturnType<typeof vi.fn>;
		findPrevious: ReturnType<typeof vi.fn>;
		clearDecorations: ReturnType<typeof vi.fn>;
	};
}

describe("SearchBar", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.useFakeTimers();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
	});

	function render(searchAddon: SearchAddon) {
		act(() => {
			root.render(<SearchBar searchAddon={searchAddon} onClose={() => {}} />);
		});
		const input = container.querySelector("input");
		if (!input) throw new Error("input not rendered");
		return input;
	}

	function type(input: HTMLInputElement, value: string) {
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("debounces searches while typing instead of searching every keystroke", () => {
		const addon = mockSearchAddon();
		const input = render(addon);

		for (const partial of ["f", "fo", "foo", "foob", "foobar"]) {
			type(input, partial);
			act(() => {
				vi.advanceTimersByTime(50);
			});
		}
		expect(addon.findNext).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(addon.findNext).toHaveBeenCalledTimes(1);
		expect(addon.findNext).toHaveBeenCalledWith("foobar", expect.anything());
	});

	it("clears decorations when the query is emptied", () => {
		const addon = mockSearchAddon();
		const input = render(addon);

		type(input, "foo");
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(addon.findNext).toHaveBeenCalledTimes(1);

		// Snapshot the count so the assertion proves the empty-input transition
		// triggered a clear, not an incidental mount-time call.
		const clearsBefore = addon.clearDecorations.mock.calls.length;
		type(input, "");
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(addon.clearDecorations.mock.calls.length).toBe(clearsBefore + 1);
	});

	it("flushes a pending debounce on Enter without double-searching", () => {
		const addon = mockSearchAddon();
		const input = render(addon);

		type(input, "foo");
		// Press Enter before the debounce fires.
		act(() => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(addon.findNext).toHaveBeenCalledTimes(1);
		expect(addon.findNext).toHaveBeenCalledWith("foo", expect.anything());

		// The stale timer firing later must not trigger another search.
		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(addon.findNext).toHaveBeenCalledTimes(1);
	});

	it("steps to the next/previous match on Enter once the query is settled", () => {
		const addon = mockSearchAddon();
		const input = render(addon);

		type(input, "foo");
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(addon.findNext).toHaveBeenCalledTimes(1);

		act(() => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(addon.findNext).toHaveBeenCalledTimes(2);

		act(() => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					shiftKey: true,
					bubbles: true,
				}),
			);
		});
		expect(addon.findPrevious).toHaveBeenCalledTimes(1);
	});
});
