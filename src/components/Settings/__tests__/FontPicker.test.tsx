import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type FontEntry,
	SYSTEM_UI_FONT,
	systemFontToEntry,
	TERMINAL_FONTS,
} from "../../../lib/nerdFonts";
import { useSettingsStore } from "../../../stores/settingsStore";
import { FontPicker } from "../FontPicker";

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

function selectedLabels(): string[] {
	return Array.from(container.querySelectorAll('[aria-selected="true"]')).map(
		(el) => el.getAttribute("aria-label") ?? "",
	);
}

function list(): HTMLElement {
	const el = container.querySelector('[role="listbox"]');
	if (!el) throw new Error("no list rendered");
	return el as HTMLElement;
}

function render(fonts: FontEntry[], selectedFont: string) {
	act(() => {
		root.render(
			<FontPicker
				fonts={fonts}
				selectedFont={selectedFont}
				onSelect={() => {}}
				searchPlaceholder="Search"
				previewStyle="mono"
			/>,
		);
	});
}

/**
 * jsdom does no layout, so every box is 0×0 and the centring maths degenerates.
 *
 * Fake it on the prototype rather than on instances: the effect runs during the
 * very first commit and latches itself, so there is no window in which to stub a
 * real element afterwards. This leaves the arithmetic and the clamp under test;
 * only the `position: relative` / `offsetParent` half needs a real browser.
 */
const ROW_HEIGHT = 44;
const VIEWPORT = 200;

function rowIndex(el: HTMLElement): number {
	const parent = el.parentElement;
	return parent ? Array.prototype.indexOf.call(parent.children, el) : -1;
}

function fakeLayout() {
	const props: Record<string, (el: HTMLElement) => number> = {
		clientHeight: (el) =>
			el.getAttribute("role") === "listbox" ? VIEWPORT : 0,
		scrollHeight: (el) =>
			el.getAttribute("role") === "listbox"
				? el.children.length * ROW_HEIGHT
				: 0,
		offsetHeight: (el) =>
			el.getAttribute("role") === "option" ? ROW_HEIGHT : 0,
		offsetTop: (el) =>
			el.getAttribute("role") === "option" ? rowIndex(el) * ROW_HEIGHT : 0,
	};
	for (const [name, read] of Object.entries(props)) {
		Object.defineProperty(HTMLElement.prototype, name, {
			configurable: true,
			get(this: HTMLElement) {
				return read(this);
			},
		});
	}
	return () => {
		for (const name of Object.keys(props)) {
			delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
				name
			];
		}
	};
}

let restoreLayout: () => void;
beforeEach(() => {
	restoreLayout = fakeLayout();
});
afterEach(() => restoreLayout());

describe("FontPicker", () => {
	it("marks the selected font", () => {
		render(TERMINAL_FONTS, TERMINAL_FONTS[3].name);
		expect(selectedLabels()).toEqual([TERMINAL_FONTS[3].displayName]);
	});

	it("marks a row for the shipped interface-font default", () => {
		// Regression: the default `uiFontFamily` matched no enumerated system
		// family, so the interface list opened with nothing selected.
		const { uiFontFamily } = useSettingsStore.getState();
		render([SYSTEM_UI_FONT, systemFontToEntry("Helvetica")], uiFontFamily);
		expect(selectedLabels()).toEqual([SYSTEM_UI_FONT.displayName]);
	});

	it("scrolls the selected font into view", () => {
		render(TERMINAL_FONTS, TERMINAL_FONTS[5].name);
		// Row 5 centred in a 200px viewport: 5*44 - (200-44)/2 = 142, which is
		// inside the scrollable range (10 rows - viewport = 240) so it stands.
		expect(list().scrollTop).toBe(142);
	});

	it("retries once the selected font arrives in the list", () => {
		// System fonts load asynchronously, so the first render can legitimately
		// lack the selection. The effect must not latch itself shut on that pass.
		const selected = systemFontToEntry("Helvetica");
		render(TERMINAL_FONTS, selected.name);
		expect(list().scrollTop).toBe(0);

		render([...TERMINAL_FONTS, selected], selected.name);
		expect(list().scrollTop).toBeGreaterThan(0);
	});

	it("clamps the scroll to the scrollable range", () => {
		// First entry: centring wants a negative offset.
		render(TERMINAL_FONTS, TERMINAL_FONTS[0].name);
		expect(list().scrollTop).toBe(0);

		act(() => root.unmount());
		root = createRoot(container);

		// Last entry: centring overshoots the bottom of the content.
		const last = TERMINAL_FONTS[TERMINAL_FONTS.length - 1];
		render(TERMINAL_FONTS, last.name);
		const el = list();
		expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight);
	});
});
