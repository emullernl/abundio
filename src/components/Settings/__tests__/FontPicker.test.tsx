import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

/** The row whose left border is the accent — how the picker marks selection. */
function selectedLabels(): string[] {
	return Array.from(container.querySelectorAll("button"))
		.filter((b) => b.style.borderLeft.includes("var(--accent)"))
		.map((b) => b.textContent?.split("!@#$%").pop()?.trim() ?? "");
}

describe("FontPicker", () => {
	it("marks the selected font", () => {
		act(() => {
			root.render(
				<FontPicker
					fonts={TERMINAL_FONTS}
					selectedFont={TERMINAL_FONTS[3].name}
					onSelect={() => {}}
					searchPlaceholder="Search"
					previewStyle="mono"
				/>,
			);
		});
		expect(selectedLabels()).toEqual([TERMINAL_FONTS[3].displayName]);
	});

	it("marks a row for the shipped interface-font default", () => {
		// Regression: the default `uiFontFamily` matched no enumerated system
		// family, so the interface list opened with nothing selected.
		const { uiFontFamily } = useSettingsStore.getState();
		const fonts = [SYSTEM_UI_FONT, systemFontToEntry("Helvetica")];
		act(() => {
			root.render(
				<FontPicker
					fonts={fonts}
					selectedFont={uiFontFamily}
					onSelect={() => {}}
					searchPlaceholder="Search"
					previewStyle="ui"
				/>,
			);
		});
		expect(selectedLabels()).toEqual([SYSTEM_UI_FONT.displayName]);
	});
});
