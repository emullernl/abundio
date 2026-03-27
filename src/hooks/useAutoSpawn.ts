import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { agents as agentsApi } from "../lib/ipc";
import type { AgentPreset } from "../lib/types";

/**
 * When a session becomes active, auto-spawn any agent presets
 * that have autoSpawn: true.
 */
export function useAutoSpawn() {
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const getActiveSession = useSessionStore((s) => s.getActiveSession);
	const spawnedRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (!activeSessionId) return;

		const session = getActiveSession();
		if (!session) return;

		// Don't re-spawn for sessions we've already processed
		if (spawnedRef.current.has(activeSessionId)) return;
		spawnedRef.current.add(activeSessionId);

		let presets: AgentPreset[];
		try {
			presets = JSON.parse(session.agentPresetsJson) as AgentPreset[];
		} catch {
			return;
		}

		const autoPresets = presets.filter((p) => p.autoSpawn);
		if (autoPresets.length === 0) return;

		for (const preset of autoPresets) {
			agentsApi
				.spawn(session.id, preset.agentName, session.rootFolder, 80, 24)
				.catch((err) => {
					console.warn(`Failed to auto-spawn agent ${preset.agentName}:`, err);
				});
		}
	}, [activeSessionId, getActiveSession]);
}
