// Pure decisions behind `pane split`, `agent start`, `pane run` and
// `pane close` (ADR-0054).

import {
	isTaskCapable,
	optionSafePrompt,
	TASK_PROMPT_PLACEHOLDER,
} from "../agents";
import type { CodingAgent, PtyDetectionMode } from "../types";
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

export interface RunFacts {
	mode: PtyDetectionMode | null;
	exited: boolean;
	/** Shell integration has reported in this PTY (a prompt or a command). */
	integrationSeen: boolean;
	shellCommandRunning: boolean;
}

/** Why `pane run` may not type into this pane now, or null when it may. */
export function runRefusal(f: RunFacts): ControlError | null {
	if (f.exited) {
		return new ControlError("not_found", "that pane's shell has exited");
	}
	if (f.mode === "agent") {
		return new ControlError(
			"busy",
			"an Agent is running in that pane; use `abundio agent prompt`",
		);
	}
	if (!f.integrationSeen) {
		return new ControlError(
			"state_unknown",
			"cannot tell whether that shell is at its prompt (no shell integration seen yet), so nothing was typed",
		);
	}
	if (f.shellCommandRunning) {
		return new ControlError(
			"busy",
			"a command is still running in that pane; wait for it or read the pane",
		);
	}
	return null;
}

/** `pane run`'s command as typed: one line, no control characters, so it
 *  cannot carry its own Enter or escape sequences. */
export function cleanCommand(command: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we strip control characters
	return command.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
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
