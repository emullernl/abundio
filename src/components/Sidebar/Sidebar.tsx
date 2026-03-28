import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { SessionList } from "./SessionList";
import { AgentLauncher } from "./AgentLauncher";
import { agents as agentsApi } from "../../lib/ipc";
import { ChevronLeft, ChevronRight, Plus } from "../Icons";

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
		try {
			await createSession(name, folderPath);
		} catch (err) {
			console.error("Failed to create session:", err);
		} finally {
			setCreating(false);
		}
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
					width: 56,
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
					<ChevronRight size={14} />
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
			<div
				className="flex items-center justify-between"
				style={{ borderBottom: "1px solid var(--border)", height: 40, paddingLeft: 24, paddingRight: 16 }}
			>
				<div className="flex items-center gap-2">
					<span className="font-semibold" style={{ color: "var(--fg-secondary)", fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase" }}>
						Sessions
					</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={handleNewSession}
						disabled={creating}
						className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
						style={{ color: "var(--fg-secondary)" }}
						title="New Session"
					>
						<Plus size={14} />
					</button>
					<button
						type="button"
						onClick={toggleSidebar}
						className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--bg-tertiary)] transition-colors"
						style={{ color: "var(--fg-secondary)" }}
						title="Collapse sidebar"
					>
						<ChevronLeft size={14} />
					</button>
				</div>
			</div>

			{/* Session list */}
			<div className="flex-1 overflow-y-auto px-4 py-2">
				<SessionList />
			</div>

			{/* Actions */}
			<div className="px-5 py-3" style={{ borderTop: "1px solid var(--border)" }}>
				<AgentLauncher onSpawnAgent={handleSpawnAgent} />
			</div>
		</div>
	);
}
