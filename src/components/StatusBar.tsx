import { useSessionStore } from "../stores/sessionStore";

export function StatusBar() {
	const { getActiveSession, getActiveTab, focusedPaneId } = useSessionStore();
	const session = getActiveSession();
	const tab = getActiveTab();

	return (
		<div
			className="flex items-center px-5 gap-5"
			style={{
				height: "var(--statusbar-height)",
				backgroundColor: "var(--bg-secondary)",
				borderTop: "1px solid var(--border)",
				fontSize: 13,
				color: "var(--fg-secondary)",
			}}
		>
			{session ? (
				<>
					<span className="font-medium" style={{ color: "var(--accent)" }}>{session.name}</span>
					{tab && <span>{tab.name}</span>}
					<span>{session.rootFolder}</span>
					{focusedPaneId && <span>Pane: {focusedPaneId.slice(0, 8)}</span>}
				</>
			) : (
				<span>No active session</span>
			)}
		</div>
	);
}
