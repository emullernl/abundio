import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";

export function useSession() {
	const store = useSessionStore();

	useEffect(() => {
		store.loadSessions();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return store;
}
