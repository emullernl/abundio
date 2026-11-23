import { create } from "zustand";
import type { HostSettings } from "../lib/hostSettings";
import { hostsApi, joinedApi, listenToThisWindow } from "../lib/ipc";

/**
 * Which Host the Settings window edits (ADR-0064, phase 10d-3): `null` for
 * this computer, or a Host's id. The per-Host sections (Agents, Profiles,
 * the shell and scrollback part of Terminal) follow it; the rest are always
 * this computer's. It opens on the opening Window's Host (Rust puts it in
 * the URL, or sends `settings-set-host` when Settings is already open).
 */

export type SettingsHostLink =
	| { state: "connecting" }
	| { state: "ready" }
	| { state: "offline"; reason: string };

interface SettingsHostState {
	hostId: string | null;
	hostName: string;
	link: SettingsHostLink;
	/** The picked Host's settings, as last read. */
	settings: HostSettings | null;
	pick: (hostId: string | null) => void;
	/** Connect to the picked Host; `ask` lets ssh ask in Abundio's dialog. */
	connect: (ask: boolean) => Promise<void>;
	/** Read its settings again. */
	reload: () => Promise<void>;
	/** Change its settings; resolves once the Host has them. */
	update: (change: (s: HostSettings) => HostSettings) => Promise<void>;
	/** A command on the picked Host. */
	call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

export const useSettingsHostStore = create<SettingsHostState>((set, get) => ({
	hostId: null,
	hostName: "",
	link: { state: "ready" },
	settings: null,
	pick: (hostId) => {
		set({
			hostId,
			settings: null,
			link: hostId ? { state: "connecting" } : { state: "ready" },
		});
		if (!hostId) return;
		void hostsApi.list().then((hosts) => {
			if (get().hostId === hostId) {
				set({ hostName: hosts.find((h) => h.id === hostId)?.name ?? hostId });
			}
		});
		// Never asks on its own: "Connect to edit" does.
		void get().connect(false);
	},
	connect: async (ask) => {
		const hostId = get().hostId;
		if (!hostId) return;
		set({ link: { state: "connecting" } });
		try {
			await joinedApi.attach(hostId, ask);
			if (get().hostId !== hostId) return;
			set({ link: { state: "ready" } });
			await get().reload();
		} catch (e) {
			if (get().hostId === hostId)
				set({ link: { state: "offline", reason: String(e) } });
		}
	},
	reload: async () => {
		const hostId = get().hostId;
		if (!hostId) return;
		const s = await get().call<HostSettings | null>("host_settings_get");
		if (get().hostId === hostId) set({ settings: s });
	},
	update: async (change) => {
		const current = get().settings;
		if (!current) return;
		const next = change(current);
		set({ settings: next });
		await get().call<void>("host_settings_set", { settings: next });
	},
	call: <T>(command: string, args: Record<string, unknown> = {}) => {
		const hostId = get().hostId;
		if (!hostId) return Promise.reject(new Error("no Host picked"));
		return joinedApi.callOn<T>(hostId, command, args);
	},
}));

/** The Host Settings opens on: `host=` in its URL (`local`: this computer). */
export function initialSettingsHost(search: string): string | null {
	const host = new URLSearchParams(search).get("host");
	return host && host !== "local" ? host : null;
}

let listening = false;

/** Follow Rust's `settings-set-host` and the picked Host's changes. */
export function startSettingsHostSync(): void {
	if (listening) return;
	listening = true;
	void listenToThisWindow<string>("settings-set-host", (e) =>
		useSettingsHostStore
			.getState()
			.pick(e.payload && e.payload !== "local" ? e.payload : null),
	);
	void listenToThisWindow<HostSettings>("host-settings-changed", () => {
		if (useSettingsHostStore.getState().hostId) {
			void useSettingsHostStore.getState().reload();
		}
	});
}
