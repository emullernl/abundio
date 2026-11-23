import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../agents";
import { hostProbeCommands } from "../hostProbeAgents";
import type { HostSettings } from "../hostSettings";

describe("hostProbeCommands (ADR-0064)", () => {
	it("looks for every built-in Agent, switched on here or not", () => {
		const cmds = hostProbeCommands(null);
		for (const a of BUILTIN_AGENTS) expect(cmds).toContain(a.command);
	});

	it("adds the Host's own custom Agents, once each", () => {
		const settings = {
			customAgents: [
				{
					id: "c1",
					name: "Mine",
					command: "my-agent",
					builtin: false,
					enabled: true,
				},
				{
					id: "c2",
					name: "Dup",
					command: "claude",
					builtin: false,
					enabled: true,
				},
			],
		} as unknown as HostSettings;
		const cmds = hostProbeCommands(settings);
		expect(cmds).toContain("my-agent");
		expect(cmds.filter((c) => c === "claude")).toHaveLength(1);
	});
});
