import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLoader } from "./components/AppLoader";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { FileSearchPalette } from "./components/FileSearchPalette";
import { FileViewerContainer } from "./components/FileViewer/FileViewerContainer";
import { GitChangesPanel } from "./components/GitChanges/GitChangesPanel";
import { type LaunchChoice, LaunchPicker } from "./components/LaunchPicker";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { SaveConfirmDialog } from "./components/SaveConfirmDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { SplitContainer } from "./components/Terminal/SplitContainer";
import { TerminalPool } from "./components/Terminal/TerminalPool";
import { Titlebar } from "./components/Titlebar";
import { useConfirmCloseFileTab } from "./hooks/useConfirmCloseFileTab";
import { useConfirmCloseTerminalTab } from "./hooks/useConfirmCloseTerminalTab";
import { useFileReloadWatcher } from "./hooks/useFileReloadWatcher";
import { useSplitPane } from "./hooks/useSplitPane";
import { useWorkspace } from "./hooks/useWorkspace";
import { initKeybindings, registerAction } from "./lib/keybindings";
import { isMac } from "./lib/platform";
import { saveAllSnapshots } from "./lib/snapshotRegistry";
import { setAllTerminalsFontSize } from "./lib/terminalManager";
import type { PaneNode } from "./lib/types";
import { persistAllFileTabs, useExplorerStore } from "./stores/explorerStore";
import { useGitChangesStore } from "./stores/gitChangesStore";
import { usePtyActivityStore } from "./stores/ptyActivityStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useWorkspaceStore } from "./stores/workspaceStore";

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
	useFileReloadWatcher();
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
	const [fileSearchOpen, setFileSearchOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);
	const [launchPicker, setLaunchPicker] = useState<{
		purpose: "tab";
		workspaceId: string;
	} | null>(null);
	const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);

	const requestNewTab = useCallback((workspaceId: string) => {
		setLaunchPicker({ purpose: "tab", workspaceId });
	}, []);

	const requestNewWorkspace = useCallback(() => {
		setNewWorkspaceOpen(true);
	}, []);

	const handleLaunchSelect = useCallback(
		(choice: LaunchChoice) => {
			const picker = launchPicker;
			if (!picker) return;
			const agent = choice.kind === "agent" ? choice.agent : undefined;
			createTab(picker.workspaceId, agent);
		},
		[launchPicker, createTab],
	);

	const handleCreateWorkspace = useCallback(
		({
			name,
			folderPath,
			choice,
		}: {
			name: string;
			folderPath: string;
			choice: LaunchChoice;
		}) => {
			const agent = choice.kind === "agent" ? choice.agent : undefined;
			createWorkspace(name, folderPath, agent).catch((err) =>
				console.error("Failed to create workspace:", err),
			);
		},
		[createWorkspace],
	);
	const fileTabs = useExplorerStore((s) => s.fileTabs);
	const activeFileTabId = useExplorerStore((s) => s.activeFileTabId);
	const setActiveFileTab = useExplorerStore((s) => s.setActiveFileTab);
	const {
		requestClose: requestCloseFileTab,
		dialogProps: closeFileTabDialogProps,
	} = useConfirmCloseFileTab();
	const {
		requestClose: requestCloseTerminalTab,
		dialogProps: closeTerminalTabDialogProps,
	} = useConfirmCloseTerminalTab();
	const [appCloseRequested, setAppCloseRequested] = useState(false);
	const appWindowRef = useRef<Awaited<
		ReturnType<typeof getCurrentWindow>
	> | null>(null);
	const workspacesInitialized = useWorkspaceStore(
		(s) => s.workspacesInitialized,
	);
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);

	useEffect(() => {
		const cleanup = initKeybindings();
		return cleanup;
	}, []);

	const proceedWithClose = useCallback(async () => {
		const appWindow = appWindowRef.current ?? getCurrentWindow();
		await Promise.race([
			Promise.all([saveAllSnapshots(), persistAllFileTabs()]),
			new Promise((r) => setTimeout(r, 2000)),
		]);
		appWindow.destroy();
	}, []);

	// Save terminal snapshots before the window closes
	useEffect(() => {
		const appWindow = getCurrentWindow();
		appWindowRef.current = appWindow;
		const unlisten = appWindow.onCloseRequested(async (event) => {
			event.preventDefault();
			const dirtyTabs = useExplorerStore
				.getState()
				.fileTabs.filter((t) => t.isDirty);
			if (dirtyTabs.length > 0) {
				setAppCloseRequested(true);
				return;
			}
			await proceedWithClose();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [proceedWithClose]);

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
			setFileSearchOpen(false);
			setPaletteOpen((v) => !v);
		});
		registerAction("open-file-search", () => {
			setSettingsOpen(false);
			setPaletteOpen(false);
			setFileSearchOpen((v) => !v);
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
			if (workspaceId) requestNewTab(workspaceId);
		});
		registerAction("new-workspace", () => {
			requestNewWorkspace();
		});
		registerAction("close-tab", () => {
			const wsState = useWorkspaceStore.getState();
			const wsId = wsState.activeWorkspaceId;
			if (!wsId) return;
			const view = wsState.activeView[wsId] ?? "terminal";
			if (view === "file") {
				const fileTabId = useExplorerStore.getState().activeFileTabId;
				if (fileTabId) {
					requestCloseFileTab(fileTabId);
					return;
				}
			}
			const tab = wsState.getActiveTab();
			if (tab) requestCloseTerminalTab(tab.id);
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
		registerAction("search-in-workspace", () => {
			const settings = useSettingsStore.getState();
			if (settings.sidebarCollapsed) {
				settings.toggleSidebar();
			}
			settings.setSidebarBottomPanel("search");
			// Focus is handled by SearchPanel's useEffect on sidebarBottomPanel change
		});
	}, [
		splitPane,
		closePane,
		navigatePane,
		toggleMaximize,
		requestNewTab,
		requestNewWorkspace,
		requestCloseFileTab,
		requestCloseTerminalTab,
	]);

	return (
		<div className="flex flex-col h-full w-full">
			{!workspacesInitialized && <AppLoader />}
			<Titlebar />
			<div className="flex flex-1 min-h-0">
				<Sidebar
					titlebarHeight={TITLEBAR_HEIGHT}
					onRequestNewWorkspace={requestNewWorkspace}
				/>
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
								<div className="text-base">
									Create a workspace to get started
								</div>
							</div>
						</div>
					)}
					{workspaces
						.filter((w) => openedWorkspaceIds.has(w.id))
						.map((workspace) => {
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
										onNew={() => requestNewTab(workspace.id)}
										onRename={(tabId, name) => renameTab(tabId, name)}
										fileTabs={fileTabs.filter(
											(ft) => ft.workspaceId === workspace.id,
										)}
										activeFileTabId={activeFileTabId}
										activeView={activeView[workspace.id] ?? "terminal"}
										onActivateFileTab={(tabId) => setActiveFileTab(tabId)}
										onCloseFileTab={(tabId) => requestCloseFileTab(tabId)}
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
												(activeView[workspace.id] ?? "terminal") ===
													"terminal" && isTabActive;
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
				onRequestNewWorkspace={requestNewWorkspace}
			/>
			<FileSearchPalette
				open={fileSearchOpen}
				onClose={() => setFileSearchOpen(false)}
			/>
			<LaunchPicker
				isOpen={!!launchPicker}
				onClose={() => setLaunchPicker(null)}
				onSelect={handleLaunchSelect}
			/>
			<NewWorkspaceDialog
				isOpen={newWorkspaceOpen}
				onClose={() => setNewWorkspaceOpen(false)}
				onSubmit={handleCreateWorkspace}
			/>
			<SettingsPanel
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
			<TerminalPool />
			{closeFileTabDialogProps && (
				<SaveConfirmDialog {...closeFileTabDialogProps} />
			)}
			{closeTerminalTabDialogProps && (
				<ConfirmDialog {...closeTerminalTabDialogProps} />
			)}
			{appCloseRequested &&
				(() => {
					const dirtyTabs = fileTabs.filter((t) => t.isDirty);
					const name =
						dirtyTabs.length === 1
							? dirtyTabs[0].fileName
							: `${dirtyTabs.length} files`;
					return (
						<SaveConfirmDialog
							fileName={name}
							onSave={async () => {
								await Promise.all(
									dirtyTabs.map((t) =>
										useExplorerStore.getState().saveFile(t.id),
									),
								);
								setAppCloseRequested(false);
								await proceedWithClose();
							}}
							onDontSave={async () => {
								setAppCloseRequested(false);
								await proceedWithClose();
							}}
							onCancel={() => setAppCloseRequested(false)}
						/>
					);
				})()}
		</div>
	);
}
