import {
	agentsForHost,
	hostOfWorkspace,
	useHostAgentsStore,
} from "../stores/hostAgentsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWatchOfferStore } from "../stores/watchOfferStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { agentCommandFor } from "./agents";
import type { HostSettings } from "./hostSettings";
import { joinedApi, watchOfferApi } from "./ipc";
import { restartPaneWithAgent } from "./paneRestart";
import type { WatchOfferAction } from "./watchOffer";

/**
 * Answering a **Watch offer** (docs/plans/watch-offer.md). The Agent's
 * Watched toggle and the declined list are the pane's Host's (ADR-0064):
 * this computer's live in `settingsStore` (mirrored into its database), a
 * Host's are written to it.
 */

function hostOfPane(paneId: string): string | null {
	return hostOfWorkspace(
		useWorkspaceStore.getState().findWorkspaceForPane(paneId)?.id,
	);
}

/** Whether the Status Hooks setting is on for a pane's Host. */
export function hooksEnabledForPane(paneId: string): boolean {
	const host = hostOfPane(paneId);
	return host
		? (useHostAgentsStore.getState().settings[host]?.agentHooksEnabled ?? true)
		: useSettingsStore.getState().agentHooksEnabled;
}

async function changeHostSettings(
	hostId: string,
	change: (s: HostSettings) => HostSettings,
): Promise<HostSettings> {
	const now = await joinedApi.callOn<HostSettings | null>(
		hostId,
		"host_settings_get",
		{},
	);
	if (!now) throw new Error("the Host's settings cannot be read");
	const next = change(now);
	await joinedApi.callOn<void>(hostId, "host_settings_set", {
		settings: next,
	});
	void useHostAgentsStore.getState().load(hostId);
	return next;
}

/** Turn an Agent's Watched toggle on, on the pane's Host, and write its
 *  hooks and skill there (as Settings ▸ Agents does). */
async function watch(paneId: string, agentId: string): Promise<void> {
	const host = hostOfPane(paneId);
	if (!host) {
		const agent = useSettingsStore
			.getState()
			.agents.find((a) => a.id === agentId);
		if (agent && !agent.enabled)
			await useSettingsStore.getState().toggleAgent(agentId);
		return;
	}
	const s = await changeHostSettings(host, (s) => ({
		...s,
		agentSwitches: { ...s.agentSwitches, [agentId]: true },
	}));
	const on = Object.entries(s.agentSwitches)
		.filter(([, v]) => v)
		.map(([id]) => id);
	await joinedApi
		.callOn(host, "agent_hooks_provision", {
			enabled: s.agentHooksEnabled,
			enabledAgents: on,
		})
		.catch(() => {});
	await joinedApi
		.callOn(host, "agent_skill_provision", {
			enabled: s.agentSkillEnabled,
			enabledAgents: on,
		})
		.catch(() => {});
}

async function decline(paneId: string, agentId: string): Promise<void> {
	const host = hostOfPane(paneId);
	if (!host) {
		useSettingsStore.getState().declineWatchOffer(agentId);
		return;
	}
	await changeHostSettings(host, (s) => {
		const declined = s.declinedAgents ?? [];
		return declined.includes(agentId)
			? s
			: { ...s, declinedAgents: [...declined, agentId] };
	});
}

async function restart(paneId: string, agentId: string): Promise<void> {
	const command = agentCommandFor(agentsForHost(hostOfPane(paneId)), agentId);
	if (command) await restartPaneWithAgent(paneId, agentId, command);
}

/** Carry out one banner button. The pane's banner goes at once; the others
 *  follow Rust's `watch-offer-closed`. */
export async function answerWatchOffer(
	paneId: string,
	action: WatchOfferAction,
): Promise<void> {
	const offers = useWatchOfferStore.getState();
	const offer = offers.offers[paneId];
	if (!offer) return;
	const { agentId } = offer;
	offers.remove(paneId);
	try {
		switch (action) {
			case "enable":
			case "enable-restart":
				await watch(paneId, agentId);
				await watchOfferApi
					.close(paneId, agentId, { watched: true })
					.catch(() => {});
				if (action === "enable-restart") await restart(paneId, agentId);
				return;
			case "later":
				await watchOfferApi.close(paneId, agentId, { snooze: true });
				return;
			case "never":
				await decline(paneId, agentId);
				await watchOfferApi.close(paneId, agentId, {}).catch(() => {});
				return;
			case "restart":
				await restart(paneId, agentId);
				return;
		}
	} catch (e) {
		console.warn("[watch offer] the answer did not go through", e);
	}
}
