import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { SplitContainer } from "./components/Terminal/SplitContainer";
import { FileViewerContainer } from "./components/FileViewer/FileViewerContainer";
import { StatusBar } from "./components/StatusBar";
import { Titlebar } from "./components/Titlebar";
import { CommandPalette } from "./components/CommandPalette";
import { TabBar } from "./components/TabBar";
import { useSession } from "./hooks/useSession";
import { initKeybindings, registerAction } from "./lib/keybindings";
import { setAllTerminalsFontSize } from "./lib/terminalManager";
import { useSettingsStore } from "./stores/settingsStore";
import { useSplitPane } from "./hooks/useSplitPane";
import { useSessionStore } from "./stores/sessionStore";
import { useExplorerStore, persistAllFileTabs } from "./stores/explorerStore";
import { saveAllSnapshots } from "./lib/snapshotRegistry";
import { TerminalPool } from "./components/Terminal/TerminalPool";
import type { PaneNode } from "./lib/types";

const TITLEBAR_HEIGHT = 52;

function parseLayout(layoutJson: string): PaneNode | null {
	try {
		return JSON.parse(layoutJson) as PaneNode;
	} catch {
		return null;
	}
}



export function App() {
	const { focusedPaneId } = useSession();
	const sessions = useSessionStore((s) => s.sessions);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const activeTabBySession = useSessionStore((s) => s.activeTabBySession);
	const setActiveTab = useSessionStore((s) => s.setActiveTab);
	const createTab = useSessionStore((s) => s.createTab);
	const closeTab = useSessionStore((s) => s.closeTab);
	const renameTab = useSessionStore((s) => s.renameTab);
	const activeView = useSessionStore((s) => s.activeView);
	const setActiveView = useSessionStore((s) => s.setActiveView);
	const { splitPane, closePane, navigatePane, toggleMaximize } = useSplitPane();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const fileTabs = useExplorerStore((s) => s.fileTabs);
	const activeFileTabId = useExplorerStore((s) => s.activeFileTabId);
	const setActiveFileTab = useExplorerStore((s) => s.setActiveFileTab);
	const closeFileTab = useExplorerStore((s) => s.closeFileTab);

	useEffect(() => {
		const cleanup = initKeybindings();
		return cleanup;
	}, []);

	// Save terminal snapshots before the window closes
	useEffect(() => {
		const appWindow = getCurrentWindow();
		const unlisten = appWindow.onCloseRequested(async (event) => {
			event.preventDefault();
			// Save file tabs and terminal snapshots with a timeout so the window always closes
			await Promise.race([
				Promise.all([saveAllSnapshots(), persistAllFileTabs()]),
				new Promise((r) => setTimeout(r, 2000)),
			]);
			appWindow.destroy();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
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
		registerAction("command-palette", () => setPaletteOpen((v) => !v));
		registerAction("search-in-terminal", () => useSessionStore.getState().toggleSearch());
		registerAction("new-tab", () => {
			const sessionId = useSessionStore.getState().activeSessionId;
			if (sessionId) useSessionStore.getState().createTab(sessionId);
		});
		registerAction("close-tab", () => {
			const tab = useSessionStore.getState().getActiveTab();
			if (tab) useSessionStore.getState().closeTab(tab.id);
		});
		registerAction("next-tab", () => {
			const state = useSessionStore.getState();
			const session = state.getActiveSession();
			if (!session || session.tabs.length <= 1) return;
			const currentTabId = state.activeTabBySession[session.id];
			const idx = session.tabs.findIndex((t) => t.id === currentTabId);
			const nextIdx = (idx + 1) % session.tabs.length;
			state.setActiveTab(session.id, session.tabs[nextIdx].id);
		});
		registerAction("prev-tab", () => {
			const state = useSessionStore.getState();
			const session = state.getActiveSession();
			if (!session || session.tabs.length <= 1) return;
			const currentTabId = state.activeTabBySession[session.id];
			const idx = session.tabs.findIndex((t) => t.id === currentTabId);
			const prevIdx = (idx - 1 + session.tabs.length) % session.tabs.length;
			state.setActiveTab(session.id, session.tabs[prevIdx].id);
		});
		registerAction("font-size-increase", () => {
			const { fontSize, setFontSize } = useSettingsStore.getState();
			const newSize = Math.min(fontSize + 1, 32);
			setFontSize(newSize);
			setAllTerminalsFontSize(newSize);
		});
		registerAction("font-size-decrease", () => {
			const { fontSize, setFontSize } = useSettingsStore.getState();
			const newSize = Math.max(fontSize - 1, 8);
			setFontSize(newSize);
			setAllTerminalsFontSize(newSize);
		});
		registerAction("save-file", () => {
			const { activeFileTabId } = useExplorerStore.getState();
			if (activeFileTabId) {
				useExplorerStore.getState().saveFile(activeFileTabId);
			}
		});
	}, [focusedPaneId, splitPane, closePane, navigatePane, toggleMaximize]);

	return (
		<div className="flex flex-col h-full w-full">
			<Titlebar />
			<div className="flex flex-1 min-h-0">
				<Sidebar titlebarHeight={TITLEBAR_HEIGHT} />
				<div className="flex-1 min-w-0 flex flex-col" style={{ paddingTop: TITLEBAR_HEIGHT }}>
					{!activeSessionId && (
						<div
							className="flex items-center justify-center flex-1"
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
					{sessions.map((session) => {
						const isActive = session.id === activeSessionId;
						const activeTabId = activeTabBySession[session.id];
						return (
							<div
								key={session.id}
								className="flex-1 min-h-0 flex flex-col"
								style={{ display: isActive ? "flex" : "none" }}
							>
								<TabBar
									tabs={session.tabs}
									activeTabId={activeTabId}
									onActivate={(tabId) => {
										setActiveTab(session.id, tabId);
										setActiveView(session.id, "terminal");
									}}
									onClose={(tabId) => closeTab(tabId)}
									onNew={() => createTab(session.id)}
									onRename={(tabId, name) => renameTab(tabId, name)}
									fileTabs={fileTabs.filter((ft) => ft.sessionId === session.id)}
									activeFileTabId={activeFileTabId}
									activeView={activeView[session.id] ?? "terminal"}
									onActivateFileTab={(tabId) => setActiveFileTab(tabId)}
									onCloseFileTab={(tabId) => closeFileTab(tabId)}
								/>
								<div className="flex-1 min-h-0 relative">
									<div
										className="absolute inset-0"
										style={{
											display:
												(activeView[session.id] ?? "terminal") === "file" && activeFileTabId
													? "block"
													: "none",
										}}
									>
										<FileViewerContainer />
									</div>
									{session.tabs.map((tab) => {
										const layout = parseLayout(tab.layoutJson);
										if (!layout) return null;
										const isTabActive = tab.id === activeTabId;
										const showTerminal = (activeView[session.id] ?? "terminal") === "terminal" && isTabActive;
										return (
											<div
												key={tab.id}
												className="absolute inset-0"
												style={{ display: showTerminal ? "block" : "none" }}
											>
												<SplitContainer node={layout} cwd={session.rootFolder} />
											</div>
										);
									})}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			<StatusBar />
			<CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
			<TerminalPool />
		</div>
	);
}
