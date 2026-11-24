import type { CodingAgent } from "./types";

/**
 * **Host settings** (ADR-0064, `GLOSSARY.md`), as a Host keeps them
 * (`host_settings.rs`): which built-in Agents are on there, its custom
 * Agents, whether Abundio writes its hooks and skill into them, its default
 * shell and scrollback.
 */
export interface HostSettings {
	/** Built-in Agent id → on here. One not listed is off. */
	agentSwitches: Record<string, boolean>;
	customAgents: CodingAgent[];
	agentHooksEnabled: boolean;
	agentSkillEnabled: boolean;
	/** `null`: the user's login shell. */
	shellPath: string | null;
	/** `null`: the app's default. */
	scrollback: number | null;
	/** Built-in Agents answered *Never* in a **Watch offer**. Missing from
	 *  an older Host's record. */
	declinedAgents?: string[];
}

/** This computer's Host settings as the app kept them until now, in its own
 *  storage: written once into this computer's database (phase 10d-1). */
export function hostSettingsFromApp(app: {
	agents: CodingAgent[];
	agentHooksEnabled: boolean;
	agentSkillEnabled: boolean;
	shellPath: string | null;
	terminalScrollback: number;
	declinedWatchOffers: string[];
}): HostSettings {
	const agentSwitches: Record<string, boolean> = {};
	for (const a of app.agents) if (a.builtin) agentSwitches[a.id] = a.enabled;
	return {
		agentSwitches,
		customAgents: app.agents.filter((a) => !a.builtin),
		agentHooksEnabled: app.agentHooksEnabled,
		agentSkillEnabled: app.agentSkillEnabled,
		shellPath: app.shellPath,
		scrollback: app.terminalScrollback,
		declinedAgents: app.declinedWatchOffers,
	};
}
