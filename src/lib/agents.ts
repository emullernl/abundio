import type { CodingAgent } from "./types";

/** The one element of `CodingAgent.taskArgs` that the Task prompt replaces. */
export const TASK_PROMPT_PLACEHOLDER = "{prompt}";

// Task-capable forms (see **Task-capable** in CONTEXT.md). Each keeps the
// Agent interactive; the one-shot flags (`-p`, `exec`, `run`, `--single`)
// would print an answer and exit. Kimi Code has no such form, so it carries
// no `taskArgs`. Note Qwen: a bare positional prompt there is
// one-shot, so it needs `-i` even though Claude/Codex/Grok take it bare.

export const BUILTIN_AGENTS: CodingAgent[] = [
	{
		id: "claude",
		name: "Claude Code",
		command: "claude",
		taskArgs: ["{prompt}"],
		builtin: true,
		enabled: true,
	},
	{
		id: "copilot",
		name: "GitHub Copilot CLI",
		command: "copilot",
		taskArgs: ["-i", "{prompt}"],
		builtin: true,
		enabled: true,
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		command: "gemini",
		taskArgs: ["-i", "{prompt}"],
		builtin: true,
		enabled: true,
	},
	{
		id: "codex",
		name: "Codex",
		command: "codex",
		taskArgs: ["{prompt}"],
		builtin: true,
		enabled: true,
	},
	{
		id: "opencode",
		name: "OpenCode",
		command: "opencode",
		taskArgs: ["--prompt", "{prompt}"],
		builtin: true,
		enabled: true,
	},
	{
		id: "qwen",
		name: "Qwen Code",
		command: "qwen",
		taskArgs: ["-i", "{prompt}"],
		builtin: true,
		enabled: true,
	},
	{
		id: "kimi",
		name: "Kimi Code",
		command: "kimi",
		builtin: true,
		enabled: true,
	},
	{
		id: "grok",
		name: "Grok Build",
		command: "grok",
		taskArgs: ["{prompt}"],
		builtin: true,
		enabled: true,
	},
];

/**
 * Check if a terminal title matches any enabled agent's command.
 * Uses word-boundary matching to avoid false positives (e.g. "claudette" shouldn't match "claude").
 */
export function matchTitleToAgent(
	title: string,
	agents: CodingAgent[],
): CodingAgent | null {
	if (!title) return null;
	const lower = title.toLowerCase();
	for (const agent of agents) {
		if (!agent.enabled) continue;
		const cmd = agent.command.toLowerCase();
		const re = new RegExp(`(?:^|[/\\\\\\s])${escapeRegExp(cmd)}(?:\\s|$)`);
		if (re.test(lower)) return agent;
	}
	return null;
}

/**
 * Check if a process name matches any enabled agent's command.
 * Compares the process executable name directly against agent commands.
 */
export function matchProcessToAgent(
	processName: string,
	agents: CodingAgent[],
): CodingAgent | null {
	if (!processName) return null;
	const lower = processName.toLowerCase();
	for (const agent of agents) {
		if (!agent.enabled) continue;
		if (lower === agent.command.toLowerCase()) return agent;
	}
	return null;
}

/**
 * Number of ESC presses required to cancel an in-flight agent task.
 * Claude, Gemini, and Qwen treat a single ESC as the cancellation key;
 * the others require a deliberate double-ESC. Unknown agents default to
 * double-ESC — the safer choice when we can't identify the CLI.
 * Kimi Code deliberately stays on the double-ESC default: its `Interrupt`
 * hook is the authoritative cancel signal (mapped to "idle" in
 * agentHookMap.ts), so the keystroke heuristic is only a fallback there.
 * Grok Build also stays on the default: ESC never cancels a Grok turn
 * (Ctrl+C does — verified against its bundled keyboard-shortcuts guide), and
 * its `Stop` hook with `reason: "cancelled"` is the authoritative signal.
 */
export function escPressesToCancelAgent(agentId: string | undefined): number {
	if (agentId === "claude" || agentId === "gemini" || agentId === "qwen") {
		return 1;
	}
	return 2;
}

/**
 * Returns the command strings of all enabled agents.
 */
export function getEnabledAgentCommands(agents: CodingAgent[]): string[] {
	return agents.filter((a) => a.enabled).map((a) => a.command);
}

/**
 * **Retired built-ins**: Agents an earlier release shipped as built-in and this
 * one no longer does, keyed by id. See the *Retired built-in* entry in
 * CONTEXT.md and ADR-0043.
 *
 * `mergeAgentsWithBuiltins` converts a persisted, Watched one into a custom
 * Agent with the **same id**, so saved Panes (`agentId` on the layout),
 * prompt-action scopes and Statistics history keep pointing at it. The id is
 * kept on purpose even though it lacks the `custom-` prefix `addAgent` gives
 * new custom Agents; nothing depends on that prefix.
 */
export const RETIRED_BUILTINS: Readonly<
	Record<string, Pick<CodingAgent, "name" | "command">>
> = {
	aider: { name: "Aider", command: "aider" },
};

/**
 * Merge persisted agents with current builtins. Keeps user customizations
 * (enabled state, custom agents) while adding any new builtins from app updates.
 *
 * A persisted **retired built-in** (still `builtin: true`, its id in
 * `RETIRED_BUILTINS`) becomes a custom Agent marked `retiredBuiltin` when it
 * was Watched, and is dropped when it was not. The rule lives here, not in a
 * persist `migrate` step, because every settings load path (the synchronous
 * first-render read, `migrate` and `merge`) runs this function; a later
 * migrate step would run after the others had already dropped it. Pure and
 * idempotent: the converted Agent is `builtin: false`, so a second pass keeps
 * it as any other custom Agent.
 */
export function mergeAgentsWithBuiltins(
	persisted: CodingAgent[],
): CodingAgent[] {
	const result: CodingAgent[] = [];
	const persistedById = new Map(persisted.map((a) => [a.id, a]));
	const builtinIds = new Set(BUILTIN_AGENTS.map((a) => a.id));

	// Add all builtins, preserving enabled state from persisted
	for (const builtin of BUILTIN_AGENTS) {
		const saved = persistedById.get(builtin.id);
		result.push({
			// `taskArgs` comes from `builtin` (code), never from `saved`: it is
			// not a user setting for built-ins, and a CLI changing its flags
			// must reach users with the app update.
			...builtin,
			enabled: saved ? saved.enabled : builtin.enabled,
		});
	}

	// Add user-created agents, and convert Watched retired built-ins into them
	for (const agent of persisted) {
		if (!agent.builtin) {
			result.push(agent);
			continue;
		}
		if (builtinIds.has(agent.id) || !agent.enabled) continue;
		const retired = RETIRED_BUILTINS[agent.id];
		if (!retired) continue;
		// Spread the persisted row so any field a built-in could carry
		// (none today: Settings only lets the user toggle one) survives.
		// `retiredBuiltin` marks it for `pruneRetiredBuiltins`.
		result.push({
			...agent,
			name: retired.name,
			command: retired.command,
			builtin: false,
			enabled: true,
			retiredBuiltin: true,
		});
	}

	return result;
}

/**
 * The shell command that launches an agent, or undefined when the agent no
 * longer exists (a deleted custom agent leaves its id stamped on the layout).
 *
 * Single source of truth for the launch string: `seedPendingAgentsForLayout`,
 * the LaunchPicker, the command palette and pane restart all go through here,
 * so a change to how args are joined cannot apply to some paths but not others.
 */
export function agentCommandFor(
	agents: CodingAgent[],
	agentId: string | undefined,
): string | undefined {
	if (!agentId) return undefined;
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) return undefined;
	return [agent.command, ...(agent.args ?? [])].join(" ");
}

/** True of an Agent that can start with a Task prompt and stay interactive. */
export function isTaskCapable(agent: CodingAgent): boolean {
	return (
		agent.taskArgs !== undefined &&
		agent.taskArgs.filter((a) => a === TASK_PROMPT_PLACEHOLDER).length === 1
	);
}

/**
 * The argv that starts an Agent with `prompt` as its first prompt, or
 * undefined when the Agent is gone or not Task-capable. The prompt is one
 * argv element, never joined into a command string: it reaches the Agent
 * without passing through a shell parser (ADR-0042). Single source of truth
 * for a Task launch, as `agentCommandFor` is for a plain one.
 */
export function agentTaskArgvFor(
	agents: CodingAgent[],
	agentId: string | undefined,
	prompt: string,
): string[] | undefined {
	const agent = agents.find((a) => a.id === agentId);
	if (!agent || !isTaskCapable(agent)) return undefined;
	return [
		// A custom Agent's command may be several words (`npx my-agent`,
		// `gh copilot`). The typed launch lets the shell split it; argv must
		// do the same or the whole string becomes one program name.
		...agent.command.trim().split(/\s+/).filter(Boolean),
		...(agent.args ?? []),
		...(agent.taskArgs ?? []).map((a) =>
			a === TASK_PROMPT_PLACEHOLDER ? optionSafePrompt(prompt) : a,
		),
	];
}

/**
 * A prompt that starts with `-` (a bullet list, `--dry-run please`) is read as
 * an option by every Task-capable CLI's argument parser, which then exits:
 * Claude `unknown option`, Codex and Grok `unexpected argument`, Gemini and
 * Qwen a missing `-i` value, Copilot `Invalid command format`. `--` is no
 * general cure — it cannot follow an option that takes the prompt as its
 * value (`-i`, `--prompt`). One leading space is: every parser checked then
 * takes it as a value, and the Agent sees the same prompt.
 */
export function optionSafePrompt(prompt: string): string {
	return prompt.startsWith("-") ? ` ${prompt}` : prompt;
}

/**
 * Parse the task argument form a user types for a custom Agent (for example
 * `-i {prompt}`). Empty input means "not Task-capable" (`taskArgs: undefined`); anything
 * without exactly one standalone `{prompt}` is an error message.
 */
export function parseTaskArgsForm(
	form: string,
): { taskArgs: string[] | undefined } | { error: string } {
	const parts = form.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { taskArgs: undefined };
	const count = parts.filter((p) => p === TASK_PROMPT_PLACEHOLDER).length;
	if (count !== 1) {
		return {
			error: `Include ${TASK_PROMPT_PLACEHOLDER} exactly once, on its own (for example: -i ${TASK_PROMPT_PLACEHOLDER})`,
		};
	}
	return { taskArgs: parts };
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
