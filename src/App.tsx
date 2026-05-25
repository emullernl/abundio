import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLoader } from "./components/AppLoader";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DragPanePreview } from "./components/DragPanePreview";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileSearchPalette } from "./components/FileSearchPalette";
import { GitChangesPanel } from "./components/GitChanges/GitChangesPanel";
import { type LaunchChoice, LaunchPicker } from "./components/LaunchPicker";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { OpenInDevEnvButton } from "./components/OpenInDevEnvButton";
import { OVERVIEW_BAR_HEIGHT, OverviewBar } from "./components/OverviewBar";
import { SaveConfirmDialog } from "./components/SaveConfirmDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { SplitContainer } from "./components/Terminal/SplitContainer";
import { TerminalPool } from "./components/Terminal/TerminalPool";
import { Titlebar } from "./components/Titlebar";
import { useConfirmCloseTerminalTab } from "./hooks/useConfirmCloseTerminalTab";
import { useFileReloadWatcher } from "./hooks/useFileReloadWatcher";
import { useGitDataSync } from "./hooks/useGitDataSync";
import { useSplitPane } from "./hooks/useSplitPane";
import { useWorkspace } from "./hooks/useWorkspace";
import { initKeybindings, registerAction } from "./lib/keybindings";
import { toggleMarkdownPreviewForPane } from "./lib/markdownPreview";
import { collectFilePaneIds } from "./lib/paneTree";
import { isMac } from "./lib/platform";
import { saveAllSnapshots } from "./lib/snapshotRegistry";
import { setAllTerminalsFontSize } from "./lib/terminalManager";
import type { PaneNode } from "./lib/types";
import { useAgentRegistryStore } from "./stores/agentRegistryStore";
import { useDevEnvironmentsStore } from "./stores/devEnvironmentsStore";
import { useExplorerStore } from "./stores/explorerStore";
import { useGitChangesStore } from "./stores/gitChangesStore";
import {
	clearPaneClose,
	usePaneCloseConfirmStore,
} from "./stores/paneCloseConfirmStore";
import {
	selectErrorAgentCount,
	selectErrorShellCount,
	selectIdleAgentCount,
	selectIdleShellCount,
	selectReadyAgentCount,
	selectReadyShellCount,
	selectWaitingAgentCount,
	selectWorkingAgentCount,
	selectWorkingShellCount,
	usePtyActivityStore,
} from "./stores/ptyActivityStore";
import { usePrStore } from "./stores/prStore";
import { useSettingsStore } from "./stores/settingsStore";
import {
	clearTabClose,
	requestTabCloseWithDirtyCheck,
	useTabCloseConfirmStore,
} from "./stores/tabCloseConfirmStore";
import { useWorkspaceStore } from "./stores/workspaceStore";

const TITLEBAR_HEIGHT = isMac ? 52 : 0;

/** Workspace-switch overlay. */
const SwitchingOverlay = memo(function SwitchingOverlay() {
	return (
		<div
			className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
			style={{
				backgroundColor: "var(--bg-primary)",
				paddingTop: TITLEBAR_HEIGHT,
				isolation: "isolate",
				contain: "layout paint",
			}}
		>
			<div
				className="flex gap-[3px]"
				style={{ width: 27, height: 14, contain: "layout paint" }}
			>
				{[0, 1, 2, 3, 4].map((i) => (
					<div
						key={i}
						style={{
							width: 3,
							height: 14,
							borderRadius: 1,
							backgroundColor: "var(--accent)",
							willChange: "transform, opacity",
							animation: `terminal-bar-wave 1.2s ease-in-out ${i * 0.12}s infinite`,
						}}
					/>
				))}
			</div>
		</div>
	);
});

/** Subscribes to the stores feeding the Overview bar so App itself doesn't
 *  re-render on every agent-state transition. Each selector returns a
 *  primitive; Zustand's default Object.is equality bails re-render unless
 *  the specific count it watches has changed. */
const OverviewBarWired = memo(function OverviewBarWired() {
	const openedWorkspaces = usePtyActivityStore(
		(s) => s.openedWorkspaceIds.size,
	);
	const totalWorkspaces = useWorkspaceStore((s) => s.workspaces.length);
	const idleAgents = usePtyActivityStore(selectIdleAgentCount);
	const workingAgents = usePtyActivityStore(selectWorkingAgentCount);
	const waitingAgents = usePtyActivityStore(selectWaitingAgentCount);
	const readyAgents = usePtyActivityStore(selectReadyAgentCount);
	const errorAgents = usePtyActivityStore(selectErrorAgentCount);
	const idleShells = usePtyActivityStore(selectIdleShellCount);
	const workingShells = usePtyActivityStore(selectWorkingShellCount);
	const readyShells = usePtyActivityStore(selectReadyShellCount);
	const errorShells = usePtyActivityStore(selectErrorShellCount);
	const reviewRequestedPrs = usePrStore((s) => s.globalReviewCount);
	const myOpenPrs = usePrStore((s) => s.globalMyPrsCount);
	const showAgentWaiting = useSettingsStore((s) => s.agentHooksEnabled);
	const showShellActivityDetail = useSettingsStore(
		(s) => s.shellActivityStatus,
	);
	return (
		<OverviewBar
			openedWorkspaces={openedWorkspaces}
			totalWorkspaces={totalWorkspaces}
			idleAgents={idleAgents}
			workingAgents={workingAgents}
			waitingAgents={waitingAgents}
			readyAgents={readyAgents}
			errorAgents={errorAgents}
			idleShells={idleShells}
			workingShells={workingShells}
			readyShells={readyShells}
			errorShells={errorShells}
			reviewRequestedPrs={reviewRequestedPrs}
			myOpenPrs={myOpenPrs}
			showAgentWaiting={showAgentWaiting}
			showShellActivityDetail={showShellActivityDetail}
		/>
	);
});

/** Memoized tab content — only re-renders when layoutJson string changes. */
const TabContent = memo(function TabContent({
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
	return (
		<ErrorBoundary
			fallback={(error, reset) => (
				<div
					className="flex flex-col items-center justify-center h-full w-full gap-3"
					style={{
						backgroundColor: "var(--bg-primary)",
						color: "var(--fg-secondary)",
					}}
				>
					<div
						className="flex flex-col items-center gap-2 p-5 rounded-lg max-w-sm text-center"
						style={{
							backgroundColor: "var(--bg-secondary)",
							border: "1px solid var(--border)",
						}}
					>
						<span
							style={{ color: "var(--error)", fontSize: 13, fontWeight: 600 }}
						>
							This tab couldn't be displayed
						</span>
						<span
							style={{ fontSize: 12, opacity: 0.7, wordBreak: "break-word" }}
						>
							{error.message || "Unknown render error"}
						</span>
						<button
							type="button"
							onClick={reset}
							style={{
								marginTop: 4,
								padding: "4px 14px",
								borderRadius: 4,
								background: "var(--accent)",
								color: "var(--bg-primary)",
								border: "none",
								fontSize: 12,
								cursor: "pointer",
								fontWeight: 500,
							}}
						>
							Retry
						</button>
						<span style={{ fontSize: 11, opacity: 0.5 }}>
							Try closing this tab or switching workspaces.
						</span>
					</div>
				</div>
			)}
		>
			<SplitContainer node={layout} cwd={cwd} />
		</ErrorBoundary>
	);
});

export function App() {
	useWorkspace();
	useFileReloadWatcher();
	useGitDataSync();
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const activeTabByWorkspace = useWorkspaceStore((s) => s.activeTabByWorkspace);
	const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
	const createTab = useWorkspaceStore((s) => s.createTab);
	const closeTab = useWorkspaceStore((s) => s.closeTab);
	const renameTab = useWorkspaceStore((s) => s.renameTab);
	const focusedPaneId = useWorkspaceStore((s) => s.focusedPaneId);
	const {
		splitPaneWithPicker,
		splitPaneWithChoice,
		closePane,
		closePaneNow,
		navigatePane,
	} = useSplitPane();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [fileSearchOpen, setFileSearchOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const createWorkspace = useWorkspaceStore((s) => s.createWorkspace);

	// LaunchPicker is shared for new-tab and split flows
	const [launchPicker, setLaunchPicker] = useState<
		| { purpose: "tab"; workspaceId: string }
		| { purpose: "split"; paneId: string; direction: "horizontal" | "vertical" }
		| null
	>(null);

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
			if (picker.purpose === "tab") {
				createTab(picker.workspaceId, agent);
			} else {
				splitPaneWithChoice(picker.paneId, picker.direction, agent);
			}
		},
		[launchPicker, createTab, splitPaneWithChoice],
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

	const {
		requestClose: requestCloseTerminalTab,
		dialogProps: closeTerminalTabDialogProps,
	} = useConfirmCloseTerminalTab();
	const {
		pendingPaneId: closePanePendingId,
		pendingLabel: closePaneLabel,
		pendingDirtyFileName: closePaneDirtyFileName,
	} = usePaneCloseConfirmStore();
	const {
		pendingTabId: tabClosePendingId,
		pendingDirtyFileName: tabCloseDirtyFileName,
		pendingOnClean: tabCloseOnClean,
	} = useTabCloseConfirmStore();

	const [appCloseRequested, setAppCloseRequested] = useState(false);
	const appWindowRef = useRef<Awaited<
		ReturnType<typeof getCurrentWindow>
	> | null>(null);
	const workspacesInitialized = useWorkspaceStore(
		(s) => s.workspacesInitialized,
	);
	const switchingWorkspaceId = useWorkspaceStore((s) => s.switchingWorkspaceId);
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);

	// Lazy-mount tabs. Active tab mounts immediately; others mount after workspace
	// switch has painted so the new workspace feels instant.
	const [mountedTabIds, setMountedTabIds] = useState<Set<string>>(
		() => new Set(),
	);

	useEffect(() => {
		const targetWorkspaceId = switchingWorkspaceId ?? activeWorkspaceId;
		if (!targetWorkspaceId) return;
		const activeTabId = activeTabByWorkspace[targetWorkspaceId];
		if (!activeTabId) return;
		setMountedTabIds((prev) => {
			if (prev.has(activeTabId)) return prev;
			const next = new Set(prev);
			next.add(activeTabId);
			return next;
		});
	}, [activeWorkspaceId, switchingWorkspaceId, activeTabByWorkspace]);

	useEffect(() => {
		if (switchingWorkspaceId !== null) return;
		if (!activeWorkspaceId) return;
		const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
		if (!workspace) return;
		const hasUnmounted = workspace.tabs.some((t) => !mountedTabIds.has(t.id));
		if (!hasUnmounted) return;
		const rafId = requestAnimationFrame(() => {
			setMountedTabIds((prev) => {
				const next = new Set(prev);
				for (const t of workspace.tabs) next.add(t.id);
				return next;
			});
		});
		return () => cancelAnimationFrame(rafId);
	}, [activeWorkspaceId, switchingWorkspaceId, workspaces, mountedTabIds]);

	useEffect(() => {
		const cleanup = initKeybindings();
		return cleanup;
	}, []);

	// Detect installed dev environments once at startup.
	useEffect(() => {
		useDevEnvironmentsStore.getState().load();
	}, []);

	// Detect installed agent CLIs once at startup.
	useEffect(() => {
		const commands = useSettingsStore.getState().agents.map((a) => a.command);
		useAgentRegistryStore.getState().load(commands);
	}, []);

	// Listen for split-with-picker events dispatched by useSplitPane
	useEffect(() => {
		const handler = (e: Event) => {
			const { paneId, direction } = (
				e as CustomEvent<{
					paneId: string;
					direction: "horizontal" | "vertical";
				}>
			).detail;
			setLaunchPicker({ purpose: "split", paneId, direction });
		};
		window.addEventListener("abundio:split-with-picker", handler);
		return () =>
			window.removeEventListener("abundio:split-with-picker", handler);
	}, []);

	const proceedWithClose = useCallback(async () => {
		const appWindow = appWindowRef.current ?? getCurrentWindow();
		await Promise.race([
			saveAllSnapshots(),
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
			const dirtyPanes = Object.values(
				useExplorerStore.getState().filePanes,
			).filter((p) => p.isDirty);
			if (dirtyPanes.length > 0) {
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
			if (paneId) splitPaneWithPicker(paneId, "horizontal");
		});
		registerAction("split-vertical", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) splitPaneWithPicker(paneId, "vertical");
		});
		registerAction("close-pane", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) closePane(paneId);
		});
		registerAction("navigate-up", () => navigatePane("up"));
		registerAction("navigate-down", () => navigatePane("down"));
		registerAction("navigate-left", () => navigatePane("left"));
		registerAction("navigate-right", () => navigatePane("right"));
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
			const tab = useWorkspaceStore.getState().getActiveTab();
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
			const explorer = useExplorerStore.getState();
			const focusedId = useWorkspaceStore.getState().focusedPaneId;
			if (focusedId && explorer.filePanes[focusedId]) {
				explorer.saveFile(focusedId);
				return;
			}
			// Focus is outside a file pane (e.g. a terminal) — save every dirty
			// file pane in the active tab so Cmd+S still works.
			const layout = useWorkspaceStore.getState().getActiveLayout();
			if (!layout) return;
			for (const pid of collectFilePaneIds(layout)) {
				if (explorer.filePanes[pid]?.isDirty) explorer.saveFile(pid);
			}
		});
		registerAction("toggle-git-panel", () => {
			useGitChangesStore.getState().togglePanel();
		});
		registerAction("toggle-markdown-preview", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) toggleMarkdownPreviewForPane(paneId);
		});
		registerAction("search-in-workspace", () => {
			const settings = useSettingsStore.getState();
			if (settings.sidebarCollapsed) {
				settings.toggleSidebar();
			}
			settings.setSidebarBottomPanel("search");
		});
	}, [
		splitPaneWithPicker,
		closePane,
		navigatePane,
		requestNewTab,
		requestNewWorkspace,
		requestCloseTerminalTab,
	]);

	// Derive the active file path for the OpenInDevEnvButton from the focused pane
	const activeFocusedFilePath = useMemo(() => {
		if (!focusedPaneId) return null;
		const pane = useExplorerStore.getState().filePanes[focusedPaneId];
		if (!pane || pane.fileType === "diff") return null;
		return pane.filePath;
	}, [focusedPaneId]);

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
					className="flex-1 min-w-0 flex flex-col relative"
					style={{ paddingTop: TITLEBAR_HEIGHT + OVERVIEW_BAR_HEIGHT }}
				>
					<div
						style={{
							position: "absolute",
							top: TITLEBAR_HEIGHT,
							left: 0,
							right: 0,
							zIndex: 40,
						}}
					>
						<OverviewBarWired />
					</div>
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
									data-workspace-active={isActive ? "true" : undefined}
									className="absolute flex flex-col"
									style={{
										top: TITLEBAR_HEIGHT + OVERVIEW_BAR_HEIGHT,
										left: 0,
										right: 0,
										bottom: 0,
										visibility: isActive ? "visible" : "hidden",
										pointerEvents: isActive ? "auto" : "none",
									}}
								>
									<div
										className="flex items-end shrink-0"
										style={{
											height: 38,
											backgroundColor: "var(--bg-primary)",
											gap: 8,
											paddingRight: 8,
										}}
									>
										<TabBar
											tabs={workspace.tabs}
											activeTabId={activeTabId}
											onActivate={(tabId) => setActiveTab(workspace.id, tabId)}
											onClose={(tabId) =>
												requestTabCloseWithDirtyCheck(tabId, () =>
													closeTab(tabId),
												)
											}
											onNew={() => requestNewTab(workspace.id)}
											onRename={(tabId, name) => renameTab(tabId, name)}
										/>
										<OpenInDevEnvButton
											workspaceFolder={workspace.rootFolder}
											activeFilePath={isActive ? activeFocusedFilePath : null}
										/>
									</div>
									<div className="flex-1 min-h-0 relative">
										{workspace.tabs.map((tab) => {
											if (!mountedTabIds.has(tab.id)) return null;
											const isTabActive = tab.id === activeTabId;
											return (
												<div
													key={tab.id}
													className="absolute inset-0"
													style={{ display: isTabActive ? "block" : "none" }}
												>
													<TabContent
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
					{switchingWorkspaceId !== null && <SwitchingOverlay />}
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
				title={
					launchPicker?.purpose === "split"
						? "Split pane with…"
						: "Start a new session"
				}
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
			{closeTerminalTabDialogProps && (
				<ConfirmDialog {...closeTerminalTabDialogProps} />
			)}
			{closePanePendingId &&
				(closePaneDirtyFileName ? (
					<SaveConfirmDialog
						fileName={closePaneDirtyFileName}
						onSave={async () => {
							const id = closePanePendingId;
							clearPaneClose();
							await useExplorerStore.getState().saveFile(id);
							await closePaneNow(id);
						}}
						onDontSave={async () => {
							const id = closePanePendingId;
							clearPaneClose();
							await closePaneNow(id);
						}}
						onCancel={clearPaneClose}
					/>
				) : (
					<ConfirmDialog
						title="Close pane?"
						message={`Close ${closePaneLabel ?? "this pane"}?`}
						confirmLabel="Close pane"
						confirmVariant="danger"
						onConfirm={() => {
							const id = closePanePendingId;
							clearPaneClose();
							closePaneNow(id);
						}}
						onCancel={clearPaneClose}
					/>
				))}
			{tabClosePendingId && tabCloseDirtyFileName && (
				<SaveConfirmDialog
					fileName={tabCloseDirtyFileName}
					onSave={async () => {
						const id = tabClosePendingId;
						const onClean = tabCloseOnClean;
						clearTabClose();
						const tab = useWorkspaceStore
							.getState()
							.workspaces.flatMap((w) => w.tabs)
							.find((t) => t.id === id);
						if (tab) {
							try {
								const layout = JSON.parse(tab.layoutJson);
								const filePanes = useExplorerStore.getState().filePanes;
								const dirtyIds = collectFilePaneIds(layout).filter(
									(pid) => filePanes[pid]?.isDirty,
								);
								await Promise.all(
									dirtyIds.map((pid) =>
										useExplorerStore.getState().saveFile(pid),
									),
								);
							} catch {
								// ignore parse errors
							}
						}
						onClean?.();
					}}
					onDontSave={() => {
						const onClean = tabCloseOnClean;
						clearTabClose();
						onClean?.();
					}}
					onCancel={clearTabClose}
				/>
			)}
			{appCloseRequested &&
				(() => {
					const dirtyEntries = Object.entries(
						useExplorerStore.getState().filePanes,
					).filter(([, p]) => p.isDirty);
					const name =
						dirtyEntries.length === 1
							? (dirtyEntries[0][1].fileName ?? "file")
							: `${dirtyEntries.length} files`;
					return (
						<SaveConfirmDialog
							fileName={name}
							onSave={async () => {
								await Promise.all(
									dirtyEntries.map(([paneId]) =>
										useExplorerStore.getState().saveFile(paneId),
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
			<DragPanePreview />
		</div>
	);
}
