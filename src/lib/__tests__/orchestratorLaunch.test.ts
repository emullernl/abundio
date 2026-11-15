import { describe, expect, it } from "vitest";
import {
	ORCHESTRATOR_FALLBACK_SECS,
	orchestratorStart,
} from "../orchestratorLaunch";
import type { CodingAgent } from "../types";

const claude = {
	id: "claude",
	name: "Claude Code",
	command: "claude",
	enabled: true,
	continueArgs: ["--continue"],
	resumeArgs: ["--resume", "{session}"],
} as unknown as CodingAgent;

const base = {
	agents: [claude],
	agentId: "claude",
	sessionId: undefined,
	resumeSetting: true,
	shellOk: true,
};

describe("orchestratorStart", () => {
	it("starts a new pick plainly, with no fallback", () => {
		expect(orchestratorStart({ ...base, mode: "fresh" })).toEqual({
			kind: "spawn",
			task: { argv: ["claude"], agentId: "claude" },
		});
	});

	it("resumes the folder's last conversation, falling back to a plain start", () => {
		expect(orchestratorStart({ ...base, mode: "resume" })).toEqual({
			kind: "spawn",
			task: {
				argv: ["claude", "--continue"],
				agentId: "claude",
				fallback: "claude",
				fallbackWithinSecs: ORCHESTRATOR_FALLBACK_SECS,
			},
		});
	});

	it("resumes a known session by id", () => {
		const start = orchestratorStart({
			...base,
			mode: "resume",
			sessionId: "abc-123",
		});
		expect(start).toMatchObject({
			kind: "spawn",
			task: { argv: ["claude", "--resume", "abc-123"], fallback: "claude" },
		});
	});

	it("does not resume with Session resume switched off", () => {
		expect(
			orchestratorStart({ ...base, mode: "resume", resumeSetting: false }),
		).toEqual({ kind: "spawn", task: { argv: ["claude"], agentId: "claude" } });
	});

	it("types the line in a shell other than zsh or bash", () => {
		expect(
			orchestratorStart({ ...base, mode: "resume", shellOk: false }),
		).toEqual({ kind: "typed", command: "claude --continue" });
	});

	it("gives nothing for an Agent that is gone", () => {
		expect(
			orchestratorStart({ ...base, agentId: "nope", mode: "fresh" }),
		).toBeUndefined();
	});
});
