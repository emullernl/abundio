import { describe, expect, it } from "vitest";
import { hostSettingsFromApp } from "../hostSettings";
import type { CodingAgent } from "../types";

const agent = (
	id: string,
	builtin: boolean,
	enabled: boolean,
): CodingAgent => ({
	id,
	name: id,
	command: id,
	builtin,
	enabled,
});

describe("hostSettingsFromApp", () => {
	it("keeps the built-ins' switches and the custom Agents whole", () => {
		const mine = agent("my-agent", false, true);
		const s = hostSettingsFromApp({
			agents: [
				agent("claude", true, true),
				agent("opencode", true, false),
				mine,
			],
			agentHooksEnabled: true,
			agentSkillEnabled: false,
			shellPath: "/bin/zsh",
			terminalScrollback: 5000,
		});
		expect(s).toEqual({
			agentSwitches: { claude: true, opencode: false },
			customAgents: [mine],
			agentHooksEnabled: true,
			agentSkillEnabled: false,
			shellPath: "/bin/zsh",
			scrollback: 5000,
		});
	});
});
