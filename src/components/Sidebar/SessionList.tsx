import { useSessionStore } from "../../stores/sessionStore";
import { SessionItem } from "./SessionItem";

export function SessionList() {
	const { sessions, activeSessionId, setActiveSession, deleteSession } = useSessionStore();

	return (
		<div className="flex flex-col gap-1">
			{sessions.map((session) => (
				<SessionItem
					key={session.id}
					session={session}
					isActive={session.id === activeSessionId}
					onClick={() => setActiveSession(session.id)}
					onDelete={() => deleteSession(session.id)}
				/>
			))}
			{sessions.length === 0 && (
				<div className="px-3 py-4 text-center text-xs" style={{ color: "var(--fg-secondary)" }}>
					No sessions yet
				</div>
			)}
		</div>
	);
}
