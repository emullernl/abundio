import type { CodingAgent } from "./types";

export const BUILTIN_AGENTS: CodingAgent[] = [
	{
		id: "claude",
		name: "Claude Code",
		command: "claude",
		builtin: true,
		enabled: true,
	},
	{
		id: "copilot",
		name: "GitHub Copilot CLI",
		command: "copilot",
		builtin: true,
		enabled: true,
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		command: "gemini",
		builtin: true,
		enabled: true,
	},
	{
		id: "aider",
		name: "Aider",
		command: "aider",
		builtin: true,
		enabled: true,
	},
	{
		id: "codex",
		name: "Codex",
		command: "codex",
		builtin: true,
		enabled: true,
	},
	{
		id: "opencode",
		name: "OpenCode",
		command: "opencode",
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
 * Returns the command strings of all enabled agents.
 */
export function getEnabledAgentCommands(agents: CodingAgent[]): string[] {
	return agents.filter((a) => a.enabled).map((a) => a.command);
}

/**
 * Merge persisted agents with current builtins. Keeps user customizations
 * (enabled state, custom agents) while adding any new builtins from app updates.
 */
export function mergeAgentsWithBuiltins(
	persisted: CodingAgent[],
): CodingAgent[] {
	const result: CodingAgent[] = [];
	const persistedById = new Map(persisted.map((a) => [a.id, a]));

	// Add all builtins, preserving enabled state from persisted
	for (const builtin of BUILTIN_AGENTS) {
		const saved = persistedById.get(builtin.id);
		result.push({
			...builtin,
			enabled: saved ? saved.enabled : builtin.enabled,
		});
	}

	// Add user-created agents
	for (const agent of persisted) {
		if (!agent.builtin) {
			result.push(agent);
		}
	}

	return result;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
