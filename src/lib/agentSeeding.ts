import type { CodingAgent } from "./types";

/**
 * Agent seeding — the one-time act of setting each built-in Agent's **Watched**
 * toggle from whether it is **Installed** on `$PATH`, so a new user's launch
 * menus and hook provisioning describe their machine rather than listing all
 * eight built-ins. See ADR-0037 and the CONTEXT.md entries for *Installed*,
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

/**
 * Settle every Agent converted from a **retired built-in** (see
 * `RETIRED_BUILTINS` in `agents.ts`) against a real `$PATH` scan: un-Watch it
 * when its command is not Installed, keep it as it is when it is, and clear
 * the `retiredBuiltin` marker either way.
 *
 * It un-Watches rather than deletes. "Not a file on the login-shell `$PATH`"
 * is narrower than "not used": a venv or conda install, a directory hook's
 * `~/bin` or a shell-function wrapper all read as not Installed. An un-Watched
 * Agent is already out of every launch menu and hook provisioning, and the
 * user can switch it back on in Settings ▸ Agents; a deleted one is gone.
 *
 * Needed because ADR-0037 left long-time users with every built-in Watched, so
 * a Watched retired built-in does not mean the user actually has it. The merge
 * cannot wait for the scan (it is async, and saved Panes would open as plain
 * shells meanwhile), so it converts first and this settles it afterwards.
 *
 * Runs on every launch until nothing carries the marker, independent of the
 * one-time seeding claim. **An empty `installed` set is a failed scan**, as in
 * `seedWatchedFromInstalled`, and changes nothing. The caller also skips it
 * when the scan ran on the fallback `$PATH` (`agentRegistry.pathIsResolved()`).
 *
 * `scanned` is the list of commands that scan looked up. A marked Agent whose
 * command is not in it is left alone: its absence from `installed` answers a
 * question nobody asked. Agents without the marker are never touched. Returns
 * the **same array reference** when nothing changes.
 */
export function pruneRetiredBuiltins(
	agents: CodingAgent[],
	installed: Set<string>,
	scanned: Set<string>,
): CodingAgent[] {
	if (installed.size === 0) return agents;

	let changed = false;
	const next = agents.map((agent) => {
		if (!agent.retiredBuiltin || !scanned.has(agent.command)) return agent;
		changed = true;
		const { retiredBuiltin: _marker, ...settled } = agent;
		return installed.has(agent.command)
			? settled
			: { ...settled, enabled: false };
	});
	return changed ? next : agents;
}
