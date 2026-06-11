import { beforeEach, describe, expect, it } from "vitest";
import {
	applyTextAssistOptOuts,
	disableNativeTextAssist,
} from "../disableNativeTextAssist";

function focus(el: HTMLElement): void {
	el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

describe("disableNativeTextAssist", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("stamps opt-out attributes on a focused input", () => {
		disableNativeTextAssist(document);
		const input = document.createElement("input");
		document.body.appendChild(input);

		focus(input);

		expect(input.getAttribute("autocorrect")).toBe("off");
		expect(input.getAttribute("autocapitalize")).toBe("off");
		expect(input.getAttribute("spellcheck")).toBe("false");
		expect(input.getAttribute("writingsuggestions")).toBe("false");
	});

	it("stamps opt-out attributes on a focused textarea", () => {
		disableNativeTextAssist(document);
		const textarea = document.createElement("textarea");
		document.body.appendChild(textarea);

		focus(textarea);

		expect(textarea.getAttribute("autocapitalize")).toBe("off");
		expect(textarea.getAttribute("autocorrect")).toBe("off");
	});

	it("does not override attributes set explicitly on the element", () => {
		const input = document.createElement("input");
		input.setAttribute("spellcheck", "true");
		input.setAttribute("autocapitalize", "sentences");

		applyTextAssistOptOuts(input);

		expect(input.getAttribute("spellcheck")).toBe("true");
		expect(input.getAttribute("autocapitalize")).toBe("sentences");
		// Unset attributes still get defaults.
		expect(input.getAttribute("autocorrect")).toBe("off");
	});

	it("ignores non-text focus targets", () => {
		disableNativeTextAssist(document);
		const button = document.createElement("button");
		document.body.appendChild(button);

		focus(button);

		expect(button.hasAttribute("autocorrect")).toBe(false);
	});
});
