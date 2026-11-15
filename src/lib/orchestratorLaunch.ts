/**
 * How the **Orchestrator**'s Agent is started (ADR-0057). Pure.
 *
 * In zsh and bash it rides the PTY spawn, as a **New task** does (ADR-0042),
 * instead of being typed: the spawn script then sees the Agent's own exit
 * code, so a resume that fails at once ("No conversation found to
 * continue") is followed by a plain start, inside the same agent-mode
 * command. Any other shell gets the typed line, with no fallback.
 */

import {
	agentCommandFor,
	agentRelaunchArgvFor,
	agentRelaunchCommandFor,
} from "./agents";
import type { PendingTask } from "./pendingAgentRegistry";
import type { CodingAgent } from "./types";

/**
 * How soon after starting a failed resume still means "nothing to resume".
 * Claude Code takes about 8 s to report that it has no conversation, so the
 * window is well past it; an Orchestrator the user worked in and then quit
 * with an error is long past it.
 */
export const ORCHESTRATOR_FALLBACK_SECS = 20;

export type OrchestratorStart =
	| { kind: "spawn"; task: PendingTask }
	| { kind: "typed"; command: string };

export function orchestratorStart(input: {
	agents: CodingAgent[];
	agentId: string;
	/** The pane's remembered session id, if any. */
	sessionId: string | undefined;
	/** `fresh`: a newly picked Agent, nothing to resume. `resume`: start it
	 *  again, resuming its last conversation if there is one. */
	mode: "fresh" | "resume";
	/** The global Session resume setting. */
	resumeSetting: boolean;
	/** The pane's shell is zsh or bash. */
	shellOk: boolean;
}): OrchestratorStart | undefined {
	const { agents, agentId, sessionId, mode, shellOk } = input;
	const plainLine = agentCommandFor(agents, agentId);
	if (!plainLine) return undefined;
	// The Orchestrator is the only Agent in its folder, so it is always alone.
	const opts = {
		sessionId,
		alone: true,
		resume: input.resumeSetting && mode === "resume",
	};
	if (!shellOk) {
		const command = agentRelaunchCommandFor(agents, agentId, opts);
		return command ? { kind: "typed", command } : undefined;
	}
	const argv = agentRelaunchArgvFor(agents, agentId, opts);
	if (!argv) return undefined;
	const plainArgv = agentRelaunchArgvFor(agents, agentId, {
		...opts,
		resume: false,
	});
	const resumes = argv.join(" ") !== plainArgv?.join(" ");
	return {
		kind: "spawn",
		task: {
			argv,
			agentId,
			...(resumes
				? {
						fallback: plainLine,
						fallbackWithinSecs: ORCHESTRATOR_FALLBACK_SECS,
					}
				: {}),
		},
	};
}
