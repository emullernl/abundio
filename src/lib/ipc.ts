import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentInfo, PtyStatusType, Session, SessionUpdate } from "./types";

export const pty = {
	spawn: (cwd: string, cols: number, rows: number, command?: string, logId?: string) =>
		invoke<string>("pty_spawn", { cwd, cols, rows, command, logId }),

	write: (ptyId: string, data: string) => invoke<void>("pty_write", { ptyId, data }),

	resize: (ptyId: string, cols: number, rows: number) =>
		invoke<void>("pty_resize", { ptyId, cols, rows }),

	kill: (ptyId: string) => invoke<void>("pty_kill", { ptyId }),

	onOutput: (ptyId: string, callback: (data: Uint8Array) => void): Promise<UnlistenFn> =>
		listen<{ data: string }>(`pty-output-${ptyId}`, (event) => {
			const binary = Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0));
			callback(binary);
		}),

	onStatus: (ptyId: string, callback: (status: PtyStatusType) => void): Promise<UnlistenFn> =>
		listen<PtyStatusType>(`pty-status-${ptyId}`, (event) => callback(event.payload)),

	readLog: async (logId: string): Promise<Uint8Array | null> => {
		const data = await invoke<string | null>("pty_read_log", { logId });
		if (!data) return null;
		return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
	},

	writeSnapshot: (paneId: string, data: string) =>
		invoke<void>("pty_write_snapshot", { paneId, data }),

	readSnapshot: (paneId: string) =>
		invoke<string | null>("pty_read_snapshot", { paneId }),

	deleteLog: (logId: string) => invoke<void>("pty_delete_log", { logId }),

	cleanupStaleLogs: (paneIds: string[]) => invoke<void>("pty_cleanup_stale_logs", { paneIds }),
};

export const sessions = {
	create: (name: string, rootFolder: string) =>
		invoke<Session>("session_create", { name, rootFolder }),

	list: () => invoke<Session[]>("session_list"),

	update: (id: string, updates: SessionUpdate) =>
		invoke<void>("session_update", { id, updates }),

	delete: (id: string) => invoke<void>("session_delete", { id }),
};

export const agents = {
	listAvailable: () => invoke<AgentInfo[]>("agents_list_available"),

	refresh: () => invoke<void>("agents_refresh"),

	spawn: (
		sessionId: string,
		agentName: string,
		cwd: string,
		cols: number,
		rows: number,
	) =>
		invoke<string>("agent_spawn", { sessionId, agentName, cwd, cols, rows }),
};
