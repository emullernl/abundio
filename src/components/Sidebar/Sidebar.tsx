import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { SessionList } from "./SessionList";
import { AgentLauncher } from "./AgentLauncher";
import { agents as agentsApi } from "../../lib/ipc";

interface SidebarProps {
	titlebarHeight: number;
}

export function Sidebar({ titlebarHeight }: SidebarProps) {
	const { createSession, getActiveSession } = useSessionStore();
	const { sidebarCollapsed, toggleSidebar } = useSettingsStore();
	const [creating, setCreating] = useState(false);

	async function handleNewSession() {
		const folder = await open({ directory: true, multiple: false });
		if (!folder) return;

		const folderPath = typeof folder === "string" ? folder : folder[0];
		if (!folderPath) return;

		const name = folderPath.split("/").pop() || "Untitled";
		setCreating(true);
		await createSession(name, folderPath);
		setCreating(false);
	}

	async function handleSpawnAgent(agentName: string) {
		const session = getActiveSession();
		if (!session) return;
		await agentsApi.spawn(session.id, agentName, session.rootFolder, 80, 24);
	}

	if (sidebarCollapsed) {
		return (
			<div
				className="flex flex-col items-center gap-2"
				style={{
					width: 48,
					paddingTop: titlebarHeight + 8,
					backgroundColor: "var(--bg-secondary)",
					borderRight: "1px solid var(--border)",
				}}
			>
				<button
					type="button"
					onClick={toggleSidebar}
					className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
					style={{ color: "var(--fg-secondary)" }}
				>
					&gt;
				</button>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col h-full"
			style={{
				width: "var(--sidebar-width)",
				backgroundColor: "var(--bg-secondary)",
				borderRight: "1px solid var(--border)",
			}}
		>
			{/* Titlebar spacer */}
			<div data-tauri-drag-region style={{ height: titlebarHeight, flexShrink: 0 }} />

			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
				<span className="text-sm font-medium" style={{ color: "var(--fg-secondary)" }}>
					Sessions
				</span>
				<button
					type="button"
					onClick={toggleSidebar}
					className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors text-sm"
					style={{ color: "var(--fg-secondary)" }}
				>
					&lt;
				</button>
			</div>

			{/* Session list */}
			<div className="flex-1 overflow-y-auto p-3">
				<SessionList />
			</div>

			{/* Actions */}
			<div className="p-3 flex flex-col gap-2.5" style={{ borderTop: "1px solid var(--border)" }}>
				<AgentLauncher onSpawnAgent={handleSpawnAgent} />
				<button
					type="button"
					onClick={handleNewSession}
					disabled={creating}
					className="w-full px-4 py-2 text-sm rounded-lg transition-colors"
					style={{
						backgroundColor: "var(--accent)",
						color: "var(--bg-primary)",
						fontWeight: 500,
					}}
				>
					{creating ? "Creating..." : "New Session"}
				</button>
			</div>
		</div>
	);
}
