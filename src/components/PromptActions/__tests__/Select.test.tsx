import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select } from "../Select";

const OPTIONS = [
	{ value: "text", label: "text" },
	{ value: "number", label: "number" },
	{ value: "choice", label: "choice" },
];

function listbox() {
	return document.querySelector('[role="listbox"]');
}

function options() {
	return [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
}

describe("Select", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let onChange: ReturnType<typeof vi.fn<(value: string) => void>>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		onChange = vi.fn<(value: string) => void>();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(value = "text") {
		act(() => {
			root.render(
				<Select
					value={value}
					options={OPTIONS}
					onChange={onChange}
					aria-label="Type"
				/>,
			);
		});
		return container.querySelector("button") as HTMLButtonElement;
	}

	function openWith(trigger: HTMLButtonElement) {
		act(() => trigger.click());
	}

	it("shows the selected option's label when closed", () => {
		const trigger = render("number");
		expect(trigger.textContent).toBe("number");
		expect(listbox()).toBeNull();
	});

	it("falls back to the placeholder when the value matches nothing", () => {
		// A `choice` parameter starts with no value chosen.
		const trigger = render("");
		expect(trigger.textContent).toBe("Choose…");
	});

	it("opens on click and lists every option", () => {
		openWith(render());
		expect(listbox()).not.toBeNull();
		expect(options().map((o) => o.textContent)).toEqual([
			"text",
			"number",
			"choice",
		]);
	});

	it("renders the list outside the component's own subtree", () => {
		// Portalled on purpose: two call sites sit inside an ancestor with
		// overflow hidden or auto, which would clip or scroll the list away.
		openWith(render());
		expect(container.querySelector('[role="listbox"]')).toBeNull();
		expect(listbox()).not.toBeNull();
	});

	it("marks only the current value as selected", () => {
		openWith(render("choice"));
		const selected = options().filter(
			(o) => o.getAttribute("aria-selected") === "true",
		);
		expect(selected).toHaveLength(1);
		expect(selected[0].textContent).toBe("choice");
	});

	it("commits the clicked option and closes", () => {
		openWith(render());
		act(() => options()[2].click());
		expect(onChange).toHaveBeenCalledWith("choice");
		expect(listbox()).toBeNull();
	});

	it("opens from the keyboard and commits with Enter", () => {
		const trigger = render("text");
		act(() => {
			trigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		});
		const list = listbox();
		expect(list).not.toBeNull();

		act(() => {
			list?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		});
		act(() => {
			list?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(onChange).toHaveBeenCalledWith("number");
	});

	it("starts the highlight on the current value, not the first option", () => {
		// So Enter straight after opening is a no-op rather than a silent change.
		const trigger = render("choice");
		openWith(trigger);
		act(() => {
			listbox()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(onChange).toHaveBeenCalledWith("choice");
	});

	it("closes without committing when a click lands outside", () => {
		openWith(render());
		act(() => {
			document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		expect(listbox()).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("closes without committing on Escape", () => {
		openWith(render());
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(listbox()).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("closes without committing when the page scrolls under it", () => {
		openWith(render());
		act(() => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(listbox()).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("survives its own scrolling", () => {
		// A capture listener on `window` sees descendant scrolls, and the list is
		// a descendant of body. Wheeling it, or `scrollIntoView` while arrowing
		// past the last visible row, would otherwise close the dropdown — the one
		// case scroll-into-view exists for.
		openWith(render());
		const list = listbox();
		act(() => {
			list?.dispatchEvent(new Event("scroll", { bubbles: false }));
		});
		expect(listbox()).not.toBeNull();
	});

	it("survives a scroll from a row inside it", () => {
		// What `scrollIntoView` on a highlighted row actually targets.
		openWith(render());
		act(() => {
			options()[1].dispatchEvent(new Event("scroll", { bubbles: false }));
		});
		expect(listbox()).not.toBeNull();
	});

	it("gives each instance its own option ids", () => {
		// `aria-activedescendant` resolves against the whole document, and
		// ParameterEditor renders one Select per parameter.
		act(() => {
			root.render(
				<>
					<Select value="text" options={OPTIONS} onChange={onChange} />
					<Select value="text" options={OPTIONS} onChange={onChange} />
				</>,
			);
		});
		const triggers = [...container.querySelectorAll("button")];
		act(() => triggers[0].click());
		const first = options().map((o) => o.id);
		act(() => {
			document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});
		act(() => triggers[1].click());
		const second = options().map((o) => o.id);
		expect(first[0]).not.toBe(second[0]);
	});

	it("does not run past either end of the list", () => {
		const trigger = render("text");
		openWith(trigger);
		const list = listbox();
		for (let i = 0; i < 6; i++) {
			act(() => {
				list?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
				);
			});
		}
		act(() => {
			list?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(onChange).toHaveBeenCalledWith("text");
	});

	describe("enterSubmits", () => {
		function renderSubmitting() {
			act(() => {
				root.render(
					<Select
						value="text"
						options={OPTIONS}
						onChange={onChange}
						aria-label="Type"
						enterSubmits
					/>,
				);
			});
			return container.querySelector("button") as HTMLButtonElement;
		}

		function keydown(el: Element, key: string) {
			const event = new KeyboardEvent("keydown", {
				key,
				bubbles: true,
				cancelable: true,
			});
			act(() => {
				el.dispatchEvent(event);
			});
			return event;
		}

		it("leaves Enter on the closed control alone", () => {
			const trigger = renderSubmitting();
			expect(trigger.hasAttribute("data-enter-submits")).toBe(true);
			const event = keydown(trigger, "Enter");
			expect(event.defaultPrevented).toBe(false);
			expect(listbox()).toBeNull();
		});

		it("still opens on ArrowDown and commits with Enter in the list", () => {
			const trigger = renderSubmitting();
			keydown(trigger, "ArrowDown");
			expect(listbox()).not.toBeNull();
			keydown(listbox() as Element, "ArrowDown");
			const event = keydown(listbox() as Element, "Enter");
			expect(event.defaultPrevented).toBe(true);
			expect(onChange).toHaveBeenCalledWith("number");
		});

		it("is off by default: Enter opens the list", () => {
			const trigger = render();
			expect(trigger.hasAttribute("data-enter-submits")).toBe(false);
			keydown(trigger, "Enter");
			expect(listbox()).not.toBeNull();
		});

		it("forwards a ref to the trigger", () => {
			const ref = { current: null as HTMLButtonElement | null };
			act(() => {
				root.render(
					<Select
						value="text"
						options={OPTIONS}
						onChange={onChange}
						ref={ref}
					/>,
				);
			});
			expect(ref.current).toBe(container.querySelector("button"));
		});
	});
});
