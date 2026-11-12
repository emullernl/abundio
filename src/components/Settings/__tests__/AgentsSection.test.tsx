import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/ipc", () => ({
	agentSkill: {
		provision: vi.fn(() => Promise.resolve()),
		provisionStartup: vi.fn(() => Promise.resolve()),
		status: vi.fn(() => Promise.resolve([])),
	},
	agentHooks: {
		status: vi.fn(() => Promise.resolve([])),
		provision: vi.fn(() => Promise.resolve()),
	},
	fs: {},
}));

import { useAgentRegistryStore } from "../../../stores/agentRegistryStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { AgentsSection } from "../AgentsSection";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	useAgentRegistryStore.setState({ reload: vi.fn(() => Promise.resolve()) });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => root.render(<AgentsSection />));
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** Set an input's value the way React notices (its value tracker). */
function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("AgentsSection Add Custom Agent", () => {
	it("keeps the Task arguments typed into the form", () => {
		const q = (sel: string) => container.querySelector(sel) as HTMLInputElement;
		type(q('input[placeholder="Name"]'), "Mine");
		type(q('input[placeholder="Command"]'), "my-agent");
		// The form's own field, not a row's: the rows come first in the DOM.
		const taskFields = container.querySelectorAll<HTMLInputElement>(
			'input[aria-label="Task arguments"]',
		);
		type(taskFields[taskFields.length - 1], "-i {prompt}");
		const add = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Add",
		);
		act(() => add?.click());

		const mine = useSettingsStore
			.getState()
			.agents.find((a) => a.name === "Mine");
		expect(mine?.command).toBe("my-agent");
		expect(mine?.taskArgs).toEqual(["-i", "{prompt}"]);
	});
});
