import { useSessionStore } from "../stores/sessionStore";
import { Folder, Grid, Terminal } from "./Icons";

function shortenPath(fullPath: string): string {
	const home = "/Users/";
	if (fullPath.startsWith(home)) {
		const afterHome = fullPath.slice(home.length);
		const slashIdx = afterHome.indexOf("/");
		if (slashIdx !== -1) {
			return `~${afterHome.slice(slashIdx)}`;
		}
		return "~";
	}
	return fullPath;
}

function Separator() {
	return (
		<span style={{ color: "var(--border)", fontSize: 10, userSelect: "none" }}>
			|
		</span>
	);
}

export function StatusBar() {
	const { getActiveSession, getActiveTab, focusedPaneId } = useSessionStore();
	const session = getActiveSession();
	const tab = getActiveTab();

	return (
		<div
			className="flex items-center justify-between"
			style={{
				height: "var(--statusbar-height)",
				paddingLeft: 24,
				paddingRight: 24,
				backgroundColor: "var(--bg-secondary)",
				borderTop: "1px solid var(--border)",
				fontSize: 12,
				color: "var(--fg-secondary)",
			}}
		>
			{session ? (
				<>
					<div className="flex items-center gap-3">
						<span className="font-medium" style={{ color: "var(--accent)" }}>
							{session.name}
						</span>
						{tab && (
							<>
								<Separator />
								<span className="flex items-center gap-1.5">
									<Terminal size={12} />
									{tab.name}
								</span>
							</>
						)}
						<Separator />
						<span className="flex items-center gap-1.5">
							<Folder size={12} />
							{shortenPath(session.rootFolder)}
						</span>
					</div>
					{focusedPaneId && (
						<span className="flex items-center gap-1.5">
							<Grid size={12} />
							<span className="font-mono" style={{ fontSize: 11 }}>
								{focusedPaneId.slice(0, 8)}
							</span>
						</span>
					)}
				</>
			) : (
				<span>No active session</span>
			)}
		</div>
	);
}
