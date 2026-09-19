import type { CodingAgent } from "./types";

/**
 * Agent seeding — the one-time act of setting each built-in Agent's **Watched**
 * toggle from whether it is **Installed** on `$PATH`, so a new user's launch
 * menus and hook provisioning describe their machine rather than listing all
 * nine built-ins. See ADR-0037 and the CONTEXT.md entries for *Installed*,
 * *Watched* and *Agent seeding*.
 *
 * Pure, and deliberately the *only* place the rule lives: the first run and the
 * Settings ▸ Agents "Match toggles to installed agents" button both call this,
 * so the button can never drift from what a fresh install would have done.
 */

/**
 * Apply installedness to the built-in Agents' Watched toggles.
 *
 * **Custom Agents are never touched.** Seeding at first run has none to touch
 * (no install has any yet), and on the button's path a command the user typed
 * in by hand is a far stronger statement of intent than a shipped default —
 * switching it off would be the button's only genuinely surprising effect.
 *
 * **An empty `installed` set is treated as a failed scan, not an empty
 * machine**, and returns the input untouched. `shell_env::shell_path()` gets
 * the real `$PATH` by running the user's login+interactive shell and gives up
 * after five seconds, falling back to a minimal PATH — which is exactly the
 * kind of first launch (cold caches, `nvm`, `compinit`) where seeding runs.
 * The two errors don't cost the same either: an Agent wrongly left on fails
 * loudly with "command not found", while one wrongly switched off silently
 * never gets detected in a pane and never gets hooks.
 *
 * Returns the **same array reference** when nothing would change, so callers
 * can skip a store write, a re-provision and a cross-Window broadcast with an
 * identity check.
 */
export function seedWatchedFromInstalled(
	agents: CodingAgent[],
	installed: Set<string>,
): CodingAgent[] {
	if (installed.size === 0) return agents;

	let changed = false;
	const next = agents.map((agent) => {
		if (!agent.builtin) return agent;
		const enabled = installed.has(agent.command);
		if (enabled === agent.enabled) return agent;
		changed = true;
		return { ...agent, enabled };
	});

	return changed ? next : agents;
}
