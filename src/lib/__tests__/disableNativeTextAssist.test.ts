import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyTextAssistOptOuts,
	disableNativeTextAssist,
} from "../disableNativeTextAssist";

function focus(el: HTMLElement): void {
	el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function expectAllOptOuts(el: HTMLElement): void {
	expect(el.getAttribute("autocorrect")).toBe("off");
	expect(el.getAttribute("autocapitalize")).toBe("off");
	expect(el.getAttribute("spellcheck")).toBe("false");
	expect(el.getAttribute("writingsuggestions")).toBe("false");
}

describe("disableNativeTextAssist", () => {
	let teardown: () => void;

	beforeEach(() => {
		document.body.innerHTML = "";
		teardown = disableNativeTextAssist(document);
	});

	afterEach(() => {
		// Remove the capture-phase listener so handlers don't stack across tests.
		teardown();
	});

	it("stamps opt-out attributes on a focused input", () => {
		const input = document.createElement("input");
		document.body.appendChild(input);

		focus(input);

		expectAllOptOuts(input);
	});

	it("stamps opt-out attributes on a focused textarea", () => {
		const textarea = document.createElement("textarea");
		document.body.appendChild(textarea);

		focus(textarea);

		expectAllOptOuts(textarea);
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
		const button = document.createElement("button");
		document.body.appendChild(button);

		focus(button);

		expect(button.hasAttribute("autocorrect")).toBe(false);
	});

	it("stops stamping after teardown", () => {
		teardown();
		const input = document.createElement("input");
		document.body.appendChild(input);

		focus(input);

		expect(input.hasAttribute("autocorrect")).toBe(false);
	});
});
