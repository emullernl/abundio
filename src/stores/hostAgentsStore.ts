import { useMemo } from "react";
import { create } from "zustand";
import { BUILTIN_AGENTS } from "../lib/agents";
import type { HostSettings } from "../lib/hostSettings";
import { joinedApi, listen } from "../lib/ipc";
import type { CodingAgent } from "../lib/types";
import { useProfileStore } from "./profileStore";
import { useSettingsStore } from "./settingsStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Each Host's Agent list, as its **Host settings** say (ADR-0064, phase
 * 10d-2): a pane recognises, launches, relaunches and names its Agents from
 * the list of its own Workspace's Host. A Workspace of this computer uses the
 * app's own list (`settingsStore.agents`, this computer's Host settings,
 * which Settings edits); a joined Workspace, or any of a remote Window, its
 * Host's, read from it.
 */

/** A Host's Agent list: the built-ins (their definitions are the app's) with
 *  that Host's switches, then its custom Agents. */
export function agentsFromHostSettings(s: HostSettings): CodingAgent[] {
	return [
		...BUILTIN_AGENTS.map((b) => ({ ...b, enabled: !!s.agentSwitches[b.id] })),
		...s.customAgents,
	];
}

interface HostAgentsState {
	/** Host id → its Agent list. */
	byHost: Record<string, CodingAgent[]>;
	/** Host id → its Host settings, as last read. */
	settings: Record<string, HostSettings>;
	/** Read a Host's settings (again). */
	load: (hostId: string) => Promise<void>;
}

const EMPTY: CodingAgent[] = [];
let listening = false;

export const useHostAgentsStore = create<HostAgentsState>((set, get) => ({
	byHost: {},
	settings: {},
	load: async (hostId) => {
		if (!listening) {
			listening = true;
			// Some Host's settings changed (the event names none): read each
			// one this Window knows again.
			void listen<HostSettings>("host-settings-changed", () => {
				for (const h of Object.keys(get().settings)) void get().load(h);
			}).catch(() => {});
		}
		const s = await joinedApi
			.callOn<HostSettings | null>(hostId, "host_settings_get", {})
			.catch(() => null);
		if (!s) return;
		set((state) => ({
			settings: { ...state.settings, [hostId]: s },
			byHost: { ...state.byHost, [hostId]: agentsFromHostSettings(s) },
		}));
	},
}));

/** The Host a Workspace is on, or `null` for this computer. */
export function hostOfWorkspace(
	workspaceId: string | null | undefined,
): string | null {
	const ws = workspaceId
		? useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
		: undefined;
	return (
		ws?.joined?.hostId ?? useProfileStore.getState().remote?.hostId ?? null
	);
}

/** A Host's Agent list; `null`: this computer's. Empty until read. */
export function agentsForHost(hostId: string | null): CodingAgent[] {
	return hostId
		? (useHostAgentsStore.getState().byHost[hostId] ?? EMPTY)
		: useSettingsStore.getState().agents;
}

export function agentsForWorkspace(
	workspaceId: string | null | undefined,
): CodingAgent[] {
	return agentsForHost(hostOfWorkspace(workspaceId));
}

export function agentsForPane(paneId: string): CodingAgent[] {
	const store = useWorkspaceStore.getState();
	return agentsForWorkspace(store.findWorkspaceForPane?.(paneId)?.id);
}

/** `agentsForWorkspace`, as a hook that follows changes. */
export function useAgentsForWorkspace(
	workspaceId: string | null | undefined,
): CodingAgent[] {
	const joinedHost = useWorkspaceStore((s) =>
		workspaceId
			? (s.workspaces.find((w) => w.id === workspaceId)?.joined?.hostId ?? null)
			: null,
	);
	const remoteHost = useProfileStore((s) => s.remote?.hostId ?? null);
	const host = joinedHost ?? remoteHost;
	const hostList = useHostAgentsStore((s) =>
		host ? (s.byHost[host] ?? EMPTY) : EMPTY,
	);
	const own = useSettingsStore((s) => s.agents);
	return host ? hostList : own;
}

/** `useAgentsForWorkspace` for the Workspace a pane is in. */
export function useAgentsForPane(
	paneId: string | null | undefined,
): CodingAgent[] {
	const workspaceId = useWorkspaceStore((s) =>
		paneId ? (s.findWorkspaceForPane(paneId)?.id ?? null) : null,
	);
	return useAgentsForWorkspace(workspaceId);
}

/** Every Agent this Window may meet: this computer's and each Host's, one
 *  per id (names, and "is this a known Agent" checks across Hosts). */
export function allAgents(): CodingAgent[] {
	const seen = new Map<string, CodingAgent>();
	for (const a of useSettingsStore.getState().agents) seen.set(a.id, a);
	for (const list of Object.values(useHostAgentsStore.getState().byHost)) {
		for (const a of list) if (!seen.has(a.id)) seen.set(a.id, a);
	}
	return [...seen.values()];
}

/** `allAgents`, as a hook that follows changes. */
export function useAllAgents(): CodingAgent[] {
	const own = useSettingsStore((s) => s.agents);
	const byHost = useHostAgentsStore((s) => s.byHost);
	// biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when either list changes
	return useMemo(() => allAgents(), [own, byHost]);
}

/** A Host's Agent list as a hook; `null`: this computer's. */
export function useAgentsForHost(hostId: string | null): CodingAgent[] {
	const hostList = useHostAgentsStore((s) =>
		hostId ? (s.byHost[hostId] ?? EMPTY) : EMPTY,
	);
	const own = useSettingsStore((s) => s.agents);
	return hostId ? hostList : own;
}

/** `hostOfWorkspace` as a hook: the Host a Workspace is on, `null` for this
 *  computer. */
export function useHostOfWorkspace(
	workspaceId: string | null | undefined,
): string | null {
	const joinedHost = useWorkspaceStore((s) =>
		workspaceId
			? (s.workspaces.find((w) => w.id === workspaceId)?.joined?.hostId ?? null)
			: null,
	);
	const remoteHost = useProfileStore((s) => s.remote?.hostId ?? null);
	return joinedHost ?? remoteHost;
}
