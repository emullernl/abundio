// **Handle prefix**: the word a **Default handle** starts with ("Claude" in
// "Claude 1"). Pure. Rust checks the prefix again (`agent_names::handle_prefix`)
// and falls back to "Agent" the same way.

import { handleKey } from "./agentHandle";
import type { CodingAgent } from "./types";

/** The prefix when the Agent is not known, or its name gives none. */
export const FALLBACK_PREFIX = "Agent";

/** One fixed word per built-in Agent. */
export const BUILTIN_HANDLE_PREFIXES: Readonly<Record<string, string>> = {
	claude: "Claude",
	copilot: "Copilot",
	gemini: "Gemini",
	codex: "Codex",
	opencode: "OpenCode",
	qwen: "Qwen",
	kimi: "Kimi",
	grok: "Grok",
	vibe: "Mistral",
};

/** Room left in a 32-character handle for " " and a number up to 99999. */
const PREFIX_MAX_LENGTH = 26;

/** Whether `word` can start a Default handle: one word, a letter first. */
export function isValidPrefix(word: string): boolean {
	return (
		word.length > 0 &&
		word.length <= PREFIX_MAX_LENGTH &&
		/^[A-Za-z][A-Za-z0-9_-]*$/.test(word)
	);
}

/** The Handle prefix for the Agent `agentId`, given the user's Agent list
 *  (for a custom Agent's name). */
export function handlePrefixFor(
	agentId: string | undefined | null,
	agents: readonly Pick<CodingAgent, "id" | "name">[],
): string {
	if (!agentId) return FALLBACK_PREFIX;
	const builtin = BUILTIN_HANDLE_PREFIXES[agentId];
	if (builtin) return builtin;
	const name = agents.find((a) => a.id === agentId)?.name ?? "";
	const first = name.trim().split(/\s+/)[0] ?? "";
	return isValidPrefix(first) ? first : FALLBACK_PREFIX;
}

/** Whether `handle` is the Default handle given before the Agent was known
 *  ("Agent 3"), so it may be renamed once it is. The older "Agent Three" is
 *  not: it was given under the old rule and is kept. */
export function isFallbackDefault(handle: string): boolean {
	return /^agent-\d+$/.test(handleKey(handle));
}
