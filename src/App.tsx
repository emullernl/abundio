import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useEffect, useMemo, useState } from "react";
import { AppLoader } from "./components/AppLoader";
import { CommandPalette } from "./components/CommandPalette";
import { FileViewerContainer } from "./components/FileViewer/FileViewerContainer";
import { GitChangesPanel } from "./components/GitChanges/GitChangesPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { SplitContainer } from "./components/Terminal/SplitContainer";
import { TerminalPool } from "./components/Terminal/TerminalPool";
import { Titlebar } from "./components/Titlebar";
import { useWorkspace } from "./hooks/useWorkspace";
import { useSplitPane } from "./hooks/useSplitPane";
import { initKeybindings, registerAction } from "./lib/keybindings";
import { isMac } from "./lib/platform";
import { saveAllSnapshots } from "./lib/snapshotRegistry";
import { setAllTerminalsFontSize } from "./lib/terminalManager";
import type { PaneNode } from "./lib/types";
import { persistAllFileTabs, useExplorerStore } from "./stores/explorerStore";
import { useGitChangesStore } from "./stores/gitChangesStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useSettingsStore } from "./stores/settingsStore";

const TITLEBAR_HEIGHT = isMac ? 52 : 0;

/** Memoized tab content — only re-renders when layoutJson string changes. */
const TabTerminalContent = memo(function TabTerminalContent({
	layoutJson,
	cwd,
}: {
	layoutJson: string;
	cwd: string;
}) {
	const layout = useMemo(() => {
		try {
			return JSON.parse(layoutJson) as PaneNode;
		} catch {
			return null;
		}
	}, [layoutJson]);

	if (!layout) return null;
	return <SplitContainer node={layout} cwd={cwd} />;
});

export function App() {
	useWorkspace();
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const activeTabByWorkspace = useWorkspaceStore((s) => s.activeTabByWorkspace);
	const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
	const createTab = useWorkspaceStore((s) => s.createTab);
	const closeTab = useWorkspaceStore((s) => s.closeTab);
	const renameTab = useWorkspaceStore((s) => s.renameTab);
	const activeView = useWorkspaceStore((s) => s.activeView);
	const setActiveView = useWorkspaceStore((s) => s.setActiveView);
	const { splitPane, closePane, navigatePane, toggleMaximize } = useSplitPane();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const fileTabs = useExplorerStore((s) => s.fileTabs);
	const activeFileTabId = useExplorerStore((s) => s.activeFileTabId);
	const setActiveFileTab = useExplorerStore((s) => s.setActiveFileTab);
	const closeFileTab = useExplorerStore((s) => s.closeFileTab);
	const workspacesInitialized = useWorkspaceStore((s) => s.workspacesInitialized);

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

	// Listen for native menu "Settings..." click
	useEffect(() => {
		const unlisten = listen("open-settings", () => {
			setPaletteOpen(false);
			setSettingsOpen(true);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		registerAction("split-horizontal", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) splitPane(paneId, "horizontal");
		});
		registerAction("split-vertical", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) splitPane(paneId, "vertical");
		});
		registerAction("close-pane", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) closePane(paneId);
		});
		registerAction("navigate-up", () => navigatePane("up"));
		registerAction("navigate-down", () => navigatePane("down"));
		registerAction("navigate-left", () => navigatePane("left"));
		registerAction("navigate-right", () => navigatePane("right"));
		registerAction("maximize-pane", () => toggleMaximize());
		registerAction("command-palette", () => {
			setSettingsOpen(false);
			setPaletteOpen((v) => !v);
		});
		registerAction("open-settings", () => {
			setPaletteOpen(false);
			setSettingsOpen(true);
		});
		registerAction("search-in-terminal", () =>
			useWorkspaceStore.getState().toggleSearch(),
		);
		registerAction("new-tab", () => {
			const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
			if (workspaceId) useWorkspaceStore.getState().createTab(workspaceId);
		});
		registerAction("close-tab", () => {
			const tab = useWorkspaceStore.getState().getActiveTab();
			if (tab) useWorkspaceStore.getState().closeTab(tab.id);
		});
		registerAction("next-tab", () => {
			const state = useWorkspaceStore.getState();
			const workspace = state.getActiveWorkspace();
			if (!workspace || workspace.tabs.length <= 1) return;
			const currentTabId = state.activeTabByWorkspace[workspace.id];
			const idx = workspace.tabs.findIndex((t) => t.id === currentTabId);
			const nextIdx = (idx + 1) % workspace.tabs.length;
			state.setActiveTab(workspace.id, workspace.tabs[nextIdx].id);
		});
		registerAction("prev-tab", () => {
			const state = useWorkspaceStore.getState();
			const workspace = state.getActiveWorkspace();
			if (!workspace || workspace.tabs.length <= 1) return;
			const currentTabId = state.activeTabByWorkspace[workspace.id];
			const idx = workspace.tabs.findIndex((t) => t.id === currentTabId);
			const prevIdx = (idx - 1 + workspace.tabs.length) % workspace.tabs.length;
			state.setActiveTab(workspace.id, workspace.tabs[prevIdx].id);
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
		registerAction("toggle-git-panel", () => {
			useGitChangesStore.getState().togglePanel();
		});
	}, [splitPane, closePane, navigatePane, toggleMaximize]);

	return (
		<div className="flex flex-col h-full w-full">
			{!workspacesInitialized && <AppLoader />}
			<Titlebar />
			<div className="flex flex-1 min-h-0">
				<Sidebar titlebarHeight={TITLEBAR_HEIGHT} />
				<div
					className="flex-1 min-w-0 flex flex-col"
					style={{ paddingTop: TITLEBAR_HEIGHT }}
				>
					{!activeWorkspaceId && (
						<div
							className="flex items-center justify-center flex-1"
							style={{ color: "var(--fg-secondary)" }}
						>
							<div className="text-center">
								<div
									className="text-2xl mb-3 font-medium"
									style={{ color: "var(--accent)" }}
								>
									Abundio
								</div>
								<div className="text-base">Create a workspace to get started</div>
							</div>
						</div>
					)}
					{workspaces.map((workspace) => {
						const isActive = workspace.id === activeWorkspaceId;
						const activeTabId = activeTabByWorkspace[workspace.id];
						return (
							<div
								key={workspace.id}
								className="flex-1 min-h-0 flex flex-col"
								style={{ display: isActive ? "flex" : "none" }}
							>
								<TabBar
									tabs={workspace.tabs}
									activeTabId={activeTabId}
									onActivate={(tabId) => {
										setActiveTab(workspace.id, tabId);
										setActiveView(workspace.id, "terminal");
									}}
									onClose={(tabId) => closeTab(tabId)}
									onNew={() => createTab(workspace.id)}
									onRename={(tabId, name) => renameTab(tabId, name)}
									fileTabs={fileTabs.filter(
										(ft) => ft.workspaceId === workspace.id,
									)}
									activeFileTabId={activeFileTabId}
									activeView={activeView[workspace.id] ?? "terminal"}
									onActivateFileTab={(tabId) => setActiveFileTab(tabId)}
									onCloseFileTab={(tabId) => closeFileTab(tabId)}
								/>
								<div className="flex-1 min-h-0 relative">
									<div
										className="absolute inset-0"
										style={{
											display:
												(activeView[workspace.id] ?? "terminal") === "file" &&
												activeFileTabId
													? "block"
													: "none",
										}}
									>
										<FileViewerContainer />
									</div>
									{workspace.tabs.map((tab) => {
										const isTabActive = tab.id === activeTabId;
										const showTerminal =
											(activeView[workspace.id] ?? "terminal") === "terminal" &&
											isTabActive;
										return (
											<div
												key={tab.id}
												className="absolute inset-0"
												style={{ display: showTerminal ? "block" : "none" }}
											>
												<TabTerminalContent
													layoutJson={tab.layoutJson}
													cwd={workspace.rootFolder}
												/>
											</div>
										);
									})}
								</div>
							</div>
						);
					})}
				</div>
				<GitChangesPanel titlebarHeight={TITLEBAR_HEIGHT} />
			</div>
			<StatusBar />
			<CommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
			/>
			<SettingsPanel
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
			<TerminalPool />
		</div>
	);
}
