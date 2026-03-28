import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { restoreFileTabs } from "../stores/explorerStore";

export function useSession() {
	const store = useSessionStore();

	useEffect(() => {
		store.loadSessions().then(() => {
			const sessions = useSessionStore.getState().sessions;
			restoreFileTabs(sessions);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return store;
}
