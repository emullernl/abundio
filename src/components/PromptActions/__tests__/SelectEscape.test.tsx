/**
 * Escape, where a `Select` sits inside another overlay.
 *
 * `useEscapeKey`'s dispatcher swallows the key before calling whichever handler
 * is topmost, so a registration that outlives the thing it closes does not
 * merely fail to act — it stops anything else from acting either. Registering
 * on the `Select` itself broke Escape in both directions:
 *
 * - closed, the Select sat on top and ate the key, so the surrounding overlay
 *   could no longer be dismissed;
 * - open, the surrounding overlay was on top (React flushes effects
 *   child-first, so the order is `[select, overlay]`) and Escape discarded the
 *   whole dialog instead of the list.
 *
 * Both are asserted here, because only one of them fails for either mistake.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { Select } from "../Select";

const OPTIONS = [
	{ value: "a", label: "a" },
	{ value: "b", label: "b" },
];

function pressEscape() {
	act(() => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
	});
}

describe("Select inside another overlay", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let onOverlayEscape: ReturnType<typeof vi.fn<() => void>>;

	/** Stands in for ParameterDialog / PromptActionPopover. */
	function Overlay({ children }: { children: React.ReactNode }) {
		useEscapeKey(onOverlayEscape);
		return <>{children}</>;
	}

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onOverlayEscape = vi.fn<() => void>();
		act(() => {
			root.render(
				<Overlay>
					<Select value="a" options={OPTIONS} onChange={() => {}} />
				</Overlay>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function trigger() {
		return container.querySelector("button") as HTMLButtonElement;
	}

	function listbox() {
		return document.querySelector('[role="listbox"]');
	}

	it("lets the surrounding overlay take Escape while the list is closed", () => {
		expect(listbox()).toBeNull();
		pressEscape();
		expect(onOverlayEscape).toHaveBeenCalledOnce();
	});

	it("lets the overlay take Escape even when the Select appeared later", () => {
		// The actual PromptActionPopover case, and the one a same-render harness
		// misses: the Select is not there when the popover opens — it appears as
		// soon as a `{{placeholder}}` is typed — so its registration was pushed
		// *after* the popover's and sat on top. A closed Select then swallowed the
		// key without acting on it, and the popover could not be dismissed at all.
		act(() => {
			root.render(<Overlay>{null}</Overlay>);
		});
		act(() => {
			root.render(
				<Overlay>
					<Select value="a" options={OPTIONS} onChange={() => {}} />
				</Overlay>,
			);
		});

		pressEscape();
		expect(onOverlayEscape).toHaveBeenCalledOnce();
	});

	it("takes Escape for the list, not the overlay, while the list is open", () => {
		act(() => trigger().click());
		expect(listbox()).not.toBeNull();

		pressEscape();
		expect(listbox()).toBeNull();
		expect(onOverlayEscape).not.toHaveBeenCalled();
	});

	it("hands Escape back to the overlay once the list has closed", () => {
		act(() => trigger().click());
		pressEscape();
		expect(onOverlayEscape).not.toHaveBeenCalled();

		pressEscape();
		expect(onOverlayEscape).toHaveBeenCalledOnce();
	});
});
