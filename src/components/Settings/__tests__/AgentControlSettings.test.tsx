import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setEnabled = vi.fn(() => Promise.resolve());
const skillProvision = vi.fn(() => Promise.resolve());
vi.mock("../../../lib/ipc", () => ({
	agentSkill: {
		provision: (...a: unknown[]) => skillProvision(...(a as [])),
		provisionStartup: vi.fn(() => Promise.resolve()),
		status: vi.fn(() =>
			Promise.resolve([
				{
					location: "shared",
					path: "/home/u/.agents/skills/abundio",
					state: "installed",
				},
				{
					location: "claude",
					path: "/home/u/.claude/skills/abundio",
					state: "conflict",
				},
			]),
		),
	},
	agentHooks: {
		status: vi.fn(() => Promise.resolve([])),
		provision: vi.fn(() => Promise.resolve()),
		provisionStartup: vi.fn(() => Promise.resolve()),
	},
	agentControl: {
		enabled: vi.fn(() => Promise.resolve(false)),
		setEnabled: (...a: unknown[]) => setEnabled(...(a as [])),
	},
	fs: {},
}));

import { useAgentRegistryStore } from "../../../stores/agentRegistryStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { AgentsSection, skillBadge } from "../AgentsSection";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
	setEnabled.mockClear();
	skillProvision.mockClear();
	useSettingsStore.setState({ agentSkillEnabled: true });
	useAgentRegistryStore.setState({ reload: vi.fn(() => Promise.resolve()) });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root.render(<AgentsSection />));
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

/** The switch in the toggle row whose label is `label`. */
function toggleFor(label: string): HTMLButtonElement {
	const row = Array.from(container.querySelectorAll("div.rounded-lg")).find(
		(d) => d.textContent?.includes(label) && d.querySelector("button"),
	);
	const button = row?.querySelector("button");
	if (!button) throw new Error(`no toggle for ${label}`);
	return button as HTMLButtonElement;
}

describe("Agent Control settings", () => {
	it("shows the Rust-held control setting and changes it there", async () => {
		await act(async () => toggleFor("Let agents control panes").click());
		// It loaded as off, so the click turns it on.
		expect(setEnabled).toHaveBeenCalledWith(true);
	});

	it("turns the skill off through the settings store", async () => {
		await act(async () => toggleFor("Install the Abundio skill").click());
		expect(useSettingsStore.getState().agentSkillEnabled).toBe(false);
		expect(skillProvision).toHaveBeenCalledWith(false, expect.any(Array));
	});

	it("lists where the skill is, with each place's state", () => {
		const text = container.textContent ?? "";
		expect(text).toContain("/home/u/.agents/skills/abundio");
		expect(text).toContain("/home/u/.claude/skills/abundio");
		expect(text).toContain("Not Abundio's — left alone");
	});
});

describe("skillBadge", () => {
	it("names each state", () => {
		expect(skillBadge(true, "installed")).toEqual({
			label: "Installed",
			tone: "success",
		});
		expect(skillBadge(true, "linked").tone).toBe("success");
		expect(skillBadge(true, "outdated").tone).toBe("warning");
		expect(skillBadge(true, "conflict").tone).toBe("error");
		expect(skillBadge(true, "absent").label).toBe("Not needed");
		expect(skillBadge(false, "absent").label).toBe("Off");
	});
});
