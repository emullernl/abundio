import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { SplitContainer } from "./components/Terminal/SplitContainer";
import { StatusBar } from "./components/StatusBar";
import { Titlebar } from "./components/Titlebar";
import { useSession } from "./hooks/useSession";
import { initKeybindings, registerAction } from "./lib/keybindings";
import { useSplitPane } from "./hooks/useSplitPane";

const TITLEBAR_HEIGHT = 52;

export function App() {
	const { getActiveSession, getActiveLayout, focusedPaneId } = useSession();
	const { splitPane, closePane, navigatePane, toggleMaximize } = useSplitPane();
	const activeSession = getActiveSession();
	const layout = getActiveLayout();

	useEffect(() => {
		const cleanup = initKeybindings();
		return cleanup;
	}, []);

	useEffect(() => {
		registerAction("split-horizontal", () => {
			if (focusedPaneId) splitPane(focusedPaneId, "horizontal");
		});
		registerAction("split-vertical", () => {
			if (focusedPaneId) splitPane(focusedPaneId, "vertical");
		});
		registerAction("close-pane", () => {
			if (focusedPaneId) closePane(focusedPaneId);
		});
		registerAction("navigate-up", () => navigatePane("up"));
		registerAction("navigate-down", () => navigatePane("down"));
		registerAction("navigate-left", () => navigatePane("left"));
		registerAction("navigate-right", () => navigatePane("right"));
		registerAction("maximize-pane", () => toggleMaximize());
	}, [focusedPaneId, splitPane, closePane, navigatePane, toggleMaximize]);

	return (
		<div className="flex flex-col h-full w-full">
			<Titlebar />
			<div className="flex flex-1 min-h-0">
				<Sidebar titlebarHeight={TITLEBAR_HEIGHT} />
				<div className="flex-1 min-w-0 flex flex-col" style={{ paddingTop: TITLEBAR_HEIGHT }}>
					<div className="flex-1 min-h-0">
						{activeSession && layout ? (
							<SplitContainer node={layout} cwd={activeSession.rootFolder} />
						) : (
							<div
								className="flex items-center justify-center h-full"
								style={{ color: "var(--fg-secondary)" }}
							>
								<div className="text-center">
									<div className="text-2xl mb-3 font-medium" style={{ color: "var(--accent)" }}>
										Abundio
									</div>
									<div className="text-base">Create a session to get started</div>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
			<StatusBar />
		</div>
	);
}
