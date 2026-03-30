import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { restoreFileTabs } from "../stores/explorerStore";

export function useSession() {
	const loadSessions = useSessionStore((s) => s.loadSessions);

	useEffect(() => {
		loadSessions().then(() => {
			const sessions = useSessionStore.getState().sessions;
			restoreFileTabs(sessions);
		});
	}, [loadSessions]);
}
