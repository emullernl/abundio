import { create } from "zustand";
import {
	hostsApi,
	type JoinedProfileRow,
	joinedApi,
	listenToThisWindow,
} from "../lib/ipc";
import { parseTabLayout } from "../lib/paneTree";
import type { WorkspaceWithTabs } from "../lib/types";
import { isOrchestrator } from "../lib/workspaceKind";
import { useHostAgentsStore } from "./hostAgentsStore";
import { fallbackProfileId, useProfileStore } from "./profileStore";
import { usePtyActivityStore } from "./ptyActivityStore";
import { useSettingsStore } from "./settingsStore";
import {
	clearPtyIds,
	onJoinedWorkspacesChanged,
	prepareLoadedWorkspaces,
	setJoinedWorkspaces,
	useWorkspaceStore,
} from "./workspaceStore";

/**
 * **Joined profiles** in this Window (docs/plans/remote-hosts.md phase 10):
 * the Remote profiles its local Profile shows, each in a section of its own,
 * and how each one's Host is reached right now.
 *
 * At Window start each joined Host connects in the background, never asking
 * (a password, 2FA or a new host key shows "Sign in needed" in the section);
 * until it answers, the section shows the Workspaces the Host last listed,
 * greyed. Its Workspaces live in the Workspace store, marked `joined`.
 */

export interface JoinedEntry {
	hostId: string;
	hostName: string;
	remoteProfileId: string;
	remoteProfileName: string;
	lastSeenMs: number | null;
}

export type JoinedLink =
	| { state: "connecting" }
	| { state: "online" }
	| { state: "offline"; reason: string; signIn: boolean };

interface JoinedState {
	entries: JoinedEntry[];
	links: Record<string, JoinedLink>;
	/** Load this Window's Joined profiles and connect to their Hosts. */
	loadJoined: () => Promise<void>;
	/** Join a Remote profile into this Window's Profile (asks, if ssh must). */
	join: (
		hostId: string,
		profile: { id: string; name: string },
	) => Promise<void>;
	/** Stop showing it here; nothing changes on the Host. */
	leave: (hostId: string) => Promise<void>;
	/** Connect again, letting ssh ask in Abundio's dialog. */
	signIn: (hostId: string) => Promise<void>;
}

/** Whether a failed connect needs the user (`needs_sign_in` in Rust). */
export function needsSignIn(reason: string): boolean {
	const r = reason.toLowerCase();
	return [
		"permission denied",
		"host key verification failed",
		"too many authentication failures",
		"no more authentication methods",
	].some((m) => r.includes(m));
}

function parseCached(json: string): WorkspaceWithTabs[] {
	try {
		const list = JSON.parse(json);
		return Array.isArray(list) ? list : [];
	} catch {
		return [];
	}
}

const shown = (list: WorkspaceWithTabs[]) =>
	list.filter((w) => !isOrchestrator(w));

let listening = false;

/** Host → the PTYs of its panes open here when it went away: what a
 *  reconnect recovers, once. A PTY started after (a pane restarted by the
 *  recovery) missed nothing, and resyncing it would replace the scrollback
 *  it restored with its Host's fresh screen. */
const missed = new Map<string, Set<string>>();

/** The Host went away: remember its panes open here. */
function noteAway(hostId: string): void {
	if (missed.has(hostId)) return;
	const act = usePtyActivityStore.getState();
	const store = useWorkspaceStore.getState();
	const ids = new Set<string>();
	for (const [paneId, ptyId] of Object.entries(act.panePtyMap)) {
		const ws = store.findWorkspaceForPane(paneId);
		if (ws?.joined?.hostId === hostId && act.openedWorkspaceIds.has(ws.id)) {
			ids.add(ptyId);
		}
	}
	missed.set(hostId, ids);
}

/** Hosts whose Opened workspaces this load already reopened. */
const restored = new Set<string>();

/**
 * **Workspace restore** (ADR-0052) for a Joined profile: reopen the
 * Workspaces its Profile has Opened, once per load, on the first answer of
 * its Host. Its panes still running there reattach. The Active workspace
 * stays the local Profile's to restore.
 */
async function restoreOpened(entry: JoinedEntry): Promise<void> {
	if (restored.has(entry.hostId)) return;
	restored.add(entry.hostId);
	if (!useSettingsStore.getState().reopenWorkspacesOnOpen) return;
	const set = await joinedApi
		.callOn<{ opened: string[]; active: string | null }>(
			entry.hostId,
			"workspace_restore_set",
			{ profileId: entry.remoteProfileId },
		)
		.catch(() => null);
	if (!set) return;
	const mine = new Set(
		useWorkspaceStore
			.getState()
			.workspaces.filter((w) => w.joined?.hostId === entry.hostId)
			.map((w) => w.id),
	);
	const activity = usePtyActivityStore.getState();
	for (const id of set.opened ?? []) {
		if (mine.has(id) && !activity.openedWorkspaceIds.has(id)) {
			activity.markWorkspaceOpened(id);
		}
	}
}

/** Recover each of a Host's joined Workspaces open in this Window: only the
 *  panes it had when it went away, and only once. */
async function recoverOpened(hostId: string): Promise<void> {
	const only = missed.get(hostId);
	missed.delete(hostId);
	if (!only || only.size === 0) return;
	const opened = usePtyActivityStore.getState().openedWorkspaceIds;
	const mine = useWorkspaceStore
		.getState()
		.workspaces.filter((w) => w.joined?.hostId === hostId && opened.has(w.id));
	const { recoverJoinedWorkspace } = await import("../lib/paneRestart");
	for (const ws of mine) {
		await recoverJoinedWorkspace(ws.id, hostId, {
			alive: (ptyIds) =>
				joinedApi.callOn<string[]>(hostId, "pty_alive", { ptyIds }),
			resync: (ptyIds) => joinedApi.callOn(hostId, "pty_resync", { ptyIds }),
			only,
		});
	}
}

export const useJoinedStore = create<JoinedState>((set, get) => {
	const setLink = (hostId: string, link: JoinedLink) =>
		set((s) => ({ links: { ...s.links, [hostId]: link } }));
	const entryOf = (hostId: string) =>
		get().entries.find((e) => e.hostId === hostId);

	/** Read the joined Profile's Workspaces from its Host. */
	const refresh = async (entry: JoinedEntry) => {
		const list = await joinedApi.callOn<WorkspaceWithTabs[]>(
			entry.hostId,
			"workspace_list",
			{ profileId: entry.remoteProfileId },
		);
		const ptyIds = list.flatMap((w) =>
			w.tabs.flatMap((t) =>
				[...t.layoutJson.matchAll(/"ptyId":"([^"]+)"/g)].map((m) => m[1]),
			),
		);
		const alive = ptyIds.length
			? await joinedApi
					.callOn<string[]>(entry.hostId, "pty_alive", { ptyIds })
					.catch(() => [])
			: [];
		setJoinedWorkspaces(
			entry.hostId,
			prepareLoadedWorkspaces(shown(list), new Set(alive)),
		);
		const now = Date.now();
		set((s) => ({
			entries: s.entries.map((e) =>
				e.hostId === entry.hostId ? { ...e, lastSeenMs: now } : e,
			),
		}));
		void joinedApi
			.seen(
				fallbackProfileId(),
				entry.hostId,
				entry.remoteProfileName,
				JSON.stringify(list),
			)
			.catch(() => {});
	};

	const connect = async (entry: JoinedEntry, ask: boolean) => {
		setLink(entry.hostId, { state: "connecting" });
		try {
			await joinedApi.join(entry.hostId, entry.remoteProfileId, ask);
			// Its Agents are its own (Host settings, ADR-0064).
			void useHostAgentsStore.getState().load(entry.hostId);
			void import("../lib/promptActionsCopy").then((m) =>
				m.copyHostPromptActionsOnce(entry.hostId).catch(() => {}),
			);
			await refresh(entry);
			setLink(entry.hostId, { state: "online" });
			await restoreOpened(entry);
			// Its Workspaces open here missed the time it was away.
			await recoverOpened(entry.hostId);
		} catch (e) {
			const reason = String(e);
			setLink(entry.hostId, {
				state: "offline",
				reason,
				signIn: needsSignIn(reason),
			});
		}
	};

	const listen = () => {
		if (listening) return;
		listening = true;
		void listenToThisWindow<{ host: string }>("host-connected", (e) => {
			const entry = entryOf(e.payload.host);
			if (entry) void connect(entry, false);
		});
		const down = (host: string, reason: string, signIn?: boolean) => {
			if (!entryOf(host)) return;
			noteAway(host);
			setLink(host, {
				state: "offline",
				reason,
				signIn: signIn ?? needsSignIn(reason),
			});
		};
		void listenToThisWindow<{ host: string; reason: string }>(
			"host-connection-lost",
			(e) => down(e.payload.host, e.payload.reason),
		);
		void listenToThisWindow<{ host: string; reason: string; signIn: boolean }>(
			"host-reconnecting",
			(e) => down(e.payload.host, e.payload.reason, e.payload.signIn),
		);
		void listenToThisWindow<{ host: string; reason: string; signIn?: boolean }>(
			"host-connect-failed",
			(e) => down(e.payload.host, e.payload.reason, e.payload.signIn),
		);
		onJoinedWorkspacesChanged((hostId, profileId) => {
			const entry = get().entries.find(
				(e) => e.hostId === hostId && e.remoteProfileId === profileId,
			);
			if (entry) void refresh(entry).catch(() => {});
		});
	};

	return {
		entries: [],
		links: {},

		loadJoined: async () => {
			// Another Profile's sections go (a Profile switch).
			for (const e of get().entries) {
				setJoinedWorkspaces(e.hostId, null);
			}
			set({ entries: [], links: {} });
			restored.clear();
			// Joining is a local Profile's (a remote Window shows one Host).
			if (useProfileStore.getState().remote) return;
			let rows: JoinedProfileRow[];
			try {
				rows = await joinedApi.list(fallbackProfileId());
			} catch {
				return;
			}
			const hosts = await hostsApi.list().catch(() => []);
			const entries = rows
				.filter((r) => hosts.some((h) => h.id === r.hostId))
				.map((r) => ({
					hostId: r.hostId,
					hostName: hosts.find((h) => h.id === r.hostId)?.name ?? r.hostId,
					remoteProfileId: r.remoteProfileId,
					remoteProfileName: r.remoteProfileName,
					lastSeenMs: r.lastSeenMs,
				}));
			set({ entries });
			listen();
			for (const [i, entry] of entries.entries()) {
				// What the Host last listed, until it answers: shown only (its
				// rows cannot open while offline), so no Agent is queued to
				// relaunch in a pane that may well still run there.
				setJoinedWorkspaces(
					entry.hostId,
					shown(parseCached(rows[i].workspacesJson)).map((w) => ({
						...w,
						tabs: w.tabs.map((t) => {
							const layout = parseTabLayout(t.layoutJson);
							return layout
								? { ...t, layoutJson: JSON.stringify(clearPtyIds(layout)) }
								: t;
						}),
					})),
				);
				void connect(entry, false);
			}
		},

		join: async (hostId, profile) => {
			if (entryOf(hostId)) {
				throw new Error(
					`this Profile already shows ${entryOf(hostId)?.remoteProfileName} from that Host; Leave it first`,
				);
			}
			await joinedApi.add(
				fallbackProfileId(),
				hostId,
				profile.id,
				profile.name,
			);
			const hosts = await hostsApi.list().catch(() => []);
			const entry: JoinedEntry = {
				hostId,
				hostName: hosts.find((h) => h.id === hostId)?.name ?? hostId,
				remoteProfileId: profile.id,
				remoteProfileName: profile.name,
				lastSeenMs: null,
			};
			set((s) => ({ entries: [...s.entries, entry] }));
			listen();
			await connect(entry, true);
		},

		leave: async (hostId) => {
			const entry = entryOf(hostId);
			if (!entry) return;
			// The panes this computer's Agents own there become ordinary
			// (ADR-0065), while the Window is still on that Host.
			await joinedApi.callOn(hostId, "control_owner_gone", {}).catch(() => {});
			await joinedApi.remove(fallbackProfileId(), hostId);
			setJoinedWorkspaces(hostId, null);
			set((s) => {
				const { [hostId]: _, ...links } = s.links;
				return { entries: s.entries.filter((e) => e.hostId !== hostId), links };
			});
		},

		signIn: async (hostId) => {
			const entry = entryOf(hostId);
			if (entry) await connect(entry, true);
		},
	};
});

/** A pane of this computer closed: the panes it owns on each connected
 *  joined Host become ordinary there (ADR-0065). */
export function releaseOwnerOnHosts(ownerPaneId: string): void {
	const { entries, links } = useJoinedStore.getState();
	for (const e of entries) {
		if (links[e.hostId]?.state !== "online") continue;
		void joinedApi
			.callOn(e.hostId, "control_owner_gone", { owner: ownerPaneId })
			.catch(() => {});
	}
}
