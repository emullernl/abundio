import { useEffect } from "react";
import { restoreFileTabs } from "../stores/explorerStore";
import { useSessionStore } from "../stores/sessionStore";

export function useSession() {
	const loadSessions = useSessionStore((s) => s.loadSessions);

	useEffect(() => {
		loadSessions().then(() => {
			const sessions = useSessionStore.getState().sessions;
			restoreFileTabs(sessions);
		});
	}, [loadSessions]);
}
