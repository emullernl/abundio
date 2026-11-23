// Pure decisions behind `pane split`, `agent start`, `pane run` and
// `pane close` (ADR-0054).

import {
	isTaskCapable,
	optionSafePrompt,
	TASK_PROMPT_PLACEHOLDER,
} from "../agents";
import type { CodingAgent } from "../types";
import { ControlError, type Direction } from "./types";

/** Split right when the caller is at least twice as wide as tall in cells,
 *  else down, so both halves stay usable. */
export function autoDirection(cols: number, rows: number): Direction {
	return cols >= 2 * rows ? "right" : "down";
}

/** A layout split's `direction` for a side: Split Right is `vertical`. */
export function layoutDirection(d: Direction): "horizontal" | "vertical" {
	return d === "right" ? "vertical" : "horizontal";
}

/**
 * The argv `agent start` launches through the New task path: the Agent's
 * command and args, then the caller's extra args (after `--`), then, with a
 * prompt, its Task arguments with the prompt as one element. Throws when the
 * Agent is unknown or switched off, or cannot take a first prompt.
 */
export function startArgv(
	agents: readonly CodingAgent[],
	kind: string,
	prompt: string | null,
	extraArgs: readonly string[],
): { agent: CodingAgent; argv: string[] } {
	const agent = agents.find((a) => a.id === kind);
	if (!agent?.enabled) {
		const known = agents
			.filter((a) => a.enabled)
			.map((a) => a.id)
			.join(", ");
		throw new ControlError(
			"not_found",
			`no Agent "${kind}" is switched on; use one of: ${known || "(none)"}`,
		);
	}
	const base = [
		...agent.command.trim().split(/\s+/).filter(Boolean),
		...(agent.args ?? []),
		...extraArgs,
	];
	if (prompt === null) return { agent, argv: base };
	if (!isTaskCapable(agent)) {
		throw new ControlError(
			"unsupported",
			`${agent.name} cannot be started with a prompt; start it without --prompt, then use \`abundio agent prompt\``,
		);
	}
	return {
		agent,
		argv: [
			...base,
			...(agent.taskArgs ?? []).map((a) =>
				a === TASK_PROMPT_PLACEHOLDER ? optionSafePrompt(prompt) : a,
			),
		],
	};
}

/** `pane close` works on any pane in reach but the caller's own: closing
 *  that would end the Agent in the middle of its own call. */
export function closeRefusal(
	callerPaneId: string,
	targetPaneId: string,
): ControlError | null {
	if (targetPaneId === callerPaneId) {
		return new ControlError(
			"not_owner",
			"an Agent cannot close its own pane; exit instead",
		);
	}
	return null;
}
