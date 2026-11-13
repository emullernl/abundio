import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: unknown[] = [];
const dismissed: unknown[] = [];
vi.mock("../../../lib/agentControl/askUser", () => ({
	answerQuestion: (...a: unknown[]) => answers.push(a),
	dismissQuestion: (...a: unknown[]) => dismissed.push(a),
}));
vi.mock("../../../hooks/useAgentHandle", () => ({
	useAgentHandle: () => "Builder",
}));

import { useAgentSignalsStore } from "../../../stores/agentSignalsStore";
import { QuestionCard } from "../QuestionCard";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
	answers.length = 0;
	dismissed.length = 0;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	useAgentSignalsStore.setState({ questions: {} });
});

function show(q: { choices: string[]; text: boolean }) {
	useAgentSignalsStore.setState({
		questions: { b: { id: "q1", question: "Ship it?", ...q } },
	});
	act(() => root.render(<QuestionCard paneId="b" />));
}

describe("QuestionCard", () => {
	it("shows nothing without a question", () => {
		act(() => root.render(<QuestionCard paneId="b" />));
		expect(host.innerHTML).toBe("");
	});

	it("answers with a choice, and never takes focus by itself", () => {
		const before = document.activeElement;
		show({ choices: ["yes", "no"], text: false });
		expect(host.textContent).toContain("Builder asks");
		expect(host.textContent).toContain("Ship it?");
		expect(host.querySelector("input")).toBeNull();
		expect(document.activeElement).toBe(before);
		const yes = [...host.querySelectorAll("button")].find(
			(b) => b.textContent === "yes",
		);
		act(() => yes?.click());
		expect(answers).toEqual([["b", "q1", { choice: "yes", text: null }]]);
	});

	it("sends typed text", () => {
		show({ choices: [], text: true });
		const input = host.querySelector("input") as HTMLInputElement;
		act(() => {
			const set = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			set?.call(input, "  tomorrow ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const form = host.querySelector("form") as HTMLFormElement;
		act(() => form.requestSubmit());
		expect(answers).toEqual([["b", "q1", { choice: null, text: "tomorrow" }]]);
	});

	it("dismisses with its close button, or Escape inside it", () => {
		show({ choices: ["yes"], text: true });
		const close = host.querySelector(
			'button[aria-label="Dismiss the question"]',
		) as HTMLButtonElement;
		act(() => close.click());
		const input = host.querySelector("input") as HTMLInputElement;
		act(() => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(dismissed).toEqual([
			["b", "q1"],
			["b", "q1"],
		]);
		expect(answers).toEqual([]);
	});
});
