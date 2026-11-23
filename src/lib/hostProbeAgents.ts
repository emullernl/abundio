import { BUILTIN_AGENTS } from "./agents";
import type { HostSettings } from "./hostSettings";

/**
 * The commands Host setup looks for on a Host: every built-in Agent, switched
 * on here or not, and that Host's own custom Agents when its Host settings
 * are known (ADR-0064). Never this computer's list: an Agent switched on
 * here need not be installed there, and the other way round. Pure.
 */
export function hostProbeCommands(settings?: HostSettings | null): string[] {
	const out = new Set(BUILTIN_AGENTS.map((a) => a.command));
	for (const a of settings?.customAgents ?? []) out.add(a.command);
	return [...out];
}
