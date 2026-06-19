import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLoader } from "./components/AppLoader";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { DragPanePreview } from "./components/DragPanePreview";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileSearchPalette } from "./components/FileSearchPalette";
import { type LaunchChoice, LaunchPicker } from "./components/LaunchPicker";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { OpenInDevEnvButton } from "./components/OpenInDevEnvButton";
import { OVERVIEW_BAR_HEIGHT, OverviewBar } from "./components/OverviewBar";
import { RightSidebar } from "./components/RightSidebar/RightSidebar";
import { SaveConfirmDialog } from "./components/SaveConfirmDialog";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatisticsOverlay } from "./components/Statistics/StatisticsOverlay";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { SplitContainer } from "./components/Terminal/SplitContainer";
import { TerminalPool } from "./components/Terminal/TerminalPool";
import { Titlebar } from "./components/Titlebar";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { useConfirmCloseTerminalTab } from "./hooks/useConfirmCloseTerminalTab";
import { useFileReloadWatcher } from "./hooks/useFileReloadWatcher";
import { useGitDataSync } from "./hooks/useGitDataSync";
import { useSplitPane } from "./hooks/useSplitPane";
import { useTerminalFileDrop } from "./hooks/useTerminalFileDrop";
import { useWorkspace } from "./hooks/useWorkspace";
import { useWorktreeSync } from "./hooks/useWorktreeSync";
import {
	finalizeAllOpenTurns,
	initAgentTurnTracker,
} from "./lib/agentTurnTracker";
import { decideWindowClose } from "./lib/closeDecision";
import { useDemoBootstrap } from "./lib/demo/useDemoBootstrap";
import { updates, windowSession } from "./lib/ipc";
import { initKeybindings, registerAction } from "./lib/keybindings";
import { toggleMarkdownPreviewForPane } from "./lib/markdownPreview";
import { collectFilePaneIds } from "./lib/paneTree";
import { isMac } from "./lib/platform";
import { saveAllSnapshots } from "./lib/snapshotRegistry";
import {
	copyTerminalSelection,
	pasteIntoTerminal,
} from "./lib/terminalClipboard";
import { setAllTerminalsFontSize } from "./lib/terminalManager";
import type { PaneNode } from "./lib/types";
import { useAgentRegistryStore } from "./stores/agentRegistryStore";
import { useDevEnvironmentsStore } from "./stores/devEnvironmentsStore";
import { useExplorerStore } from "./stores/explorerStore";
import { useNotesStore } from "./stores/notesStore";
import {
	clearPaneClose,
	usePaneCloseConfirmStore,
} from "./stores/paneCloseConfirmStore";
import { useProfileStore } from "./stores/profileStore";
import {
	cancelProfileSwitch,
	confirmProfileSwitch,
	requestSwitchProfile,
	useProfileSwitchConfirmStore,
} from "./stores/profileSwitchConfirmStore";
import { usePrStore } from "./stores/prStore";
import {
	selectErrorAgentCount,
	selectErrorShellCount,
	selectIdleAgentCount,
	selectIdleShellCount,
	selectReadyAgentCount,
	selectWaitingAgentCount,
	selectWorkingAgentCount,
	selectWorkingShellCount,
	usePtyActivityStore,
} from "./stores/ptyActivityStore";
import { useSettingsStore } from "./stores/settingsStore";
import {
	clearTabClose,
	requestTabCloseWithDirtyCheck,
	useTabCloseConfirmStore,
} from "./stores/tabCloseConfirmStore";
import { useUpdateStore } from "./stores/updateStore";
import { useWindowUiStore } from "./stores/windowUiStore";
import { useWorkspaceStore } from "./stores/workspaceStore";

// Matches the native macOS title bar height. The React Titlebar component
// renders a single-row strip of this exact height; all other layout (sidebar,
// OverviewBar, content) butts up against it with no gap.
const TITLEBAR_HEIGHT = isMac ? 28 : 0;

/** Workspace-switch overlay. */
const SwitchingOverlay = memo(function SwitchingOverlay() {
	return (
		<div
			className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none"
			style={{
				// Show the ambient gradient (matching the panes) instead of a flat
				// fill, so the workspace-switch loading screen blends in. Still
				// opaque, so it masks the layout swap underneath during the switch.
				background: "var(--ambient-glow-top), var(--bg-primary)",
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
	const errorShells = usePtyActivityStore(selectErrorShellCount);
	const reviewRequestedPrs = usePrStore((s) => s.globalReviewCount);
	const myOpenPrs = usePrStore((s) => s.globalMyPrsCount);
	const showAgentWaiting = useSettingsStore((s) => s.agentHooksEnabled);
	const prPollingEnabled = useSettingsStore((s) => s.prPollEnabled);
	const statisticsOpen = useWindowUiStore((s) => s.statisticsOverlayOpen);
	const toggleStatistics = useWindowUiStore((s) => s.toggleStatisticsOverlay);
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
			errorShells={errorShells}
			reviewRequestedPrs={reviewRequestedPrs}
			myOpenPrs={myOpenPrs}
			prPollingEnabled={prPollingEnabled}
			showAgentWaiting={showAgentWaiting}
			statisticsOpen={statisticsOpen}
			onToggleStatistics={toggleStatistics}
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
	useDemoBootstrap();
	useFileReloadWatcher();
	useGitDataSync();
	useWorktreeSync();
	useTerminalFileDrop();
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
	const pendingProfileSwitch = useProfileSwitchConfirmStore((s) => s.pending);

	const [appCloseRequested, setAppCloseRequested] = useState(false);
	// Confirm before closing a Window that has ≥1 Opened workspace (when no
	// unsaved files take precedence). See ADR-0016.
	const [workspaceCloseRequested, setWorkspaceCloseRequested] = useState(false);
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

	// Per-Workspace Notes: load the active workspace's note, and flush the
	// previous one's pending edit before swapping (the editor only debounces).
	const prevNoteWorkspaceId = useRef<string | null>(null);
	useEffect(() => {
		const prev = prevNoteWorkspaceId.current;
		if (prev && prev !== activeWorkspaceId) {
			useNotesStore
				.getState()
				.flushNote(prev)
				.catch(() => {});
		}
		if (activeWorkspaceId) {
			useNotesStore
				.getState()
				.loadNote(activeWorkspaceId)
				.catch(() => {});
		}
		prevNoteWorkspaceId.current = activeWorkspaceId;
	}, [activeWorkspaceId]);

	// Flush the active note on window close so the last keystroke survives quit.
	useEffect(() => {
		const flush = () => {
			const id = useWorkspaceStore.getState().activeWorkspaceId;
			if (id)
				useNotesStore
					.getState()
					.flushNote(id)
					.catch(() => {});
		};
		window.addEventListener("beforeunload", flush);
		return () => window.removeEventListener("beforeunload", flush);
	}, []);

	// Detect installed dev environments once at startup.
	useEffect(() => {
		useDevEnvironmentsStore.getState().load();
	}, []);

	// In-app updater: the Rust background loop checks and emits `update-available`
	// to the focused Window; download progress streams in while staging. The
	// UpdatePrompt renders from useUpdateStore. See ADR-0014.
	useEffect(() => {
		const unlistenAvailable = updates.onUpdateAvailable((info) => {
			useUpdateStore.getState().setAvailable(info);
		});
		const unlistenProgress = updates.onDownloadProgress(
			({ downloaded, total }) => {
				useUpdateStore.getState().setProgress(downloaded, total);
			},
		);
		return () => {
			unlistenAvailable.then((fn) => fn()).catch(() => {});
			unlistenProgress.then((fn) => fn()).catch(() => {});
		};
	}, []);

	// Detect installed agent CLIs once at startup.
	useEffect(() => {
		const commands = useSettingsStore.getState().agents.map((a) => a.command);
		useAgentRegistryStore.getState().load(commands);
	}, []);

	// Agent Turn telemetry: wire the tracker to the activity store. Turns are
	// persisted only at finalize (always with an end time), so a crash/hard-quit
	// just drops the in-flight Turn — there are no half-written rows to recover.
	// See ADR-0018.
	useEffect(() => {
		initAgentTurnTracker();
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
			// Best-effort: persist scrollback and flush any open agent Turns
			// (orphan recovery on next launch is the backstop if this races).
			Promise.all([saveAllSnapshots(), finalizeAllOpenTurns("app_quit")]),
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
			const dirtyPaneCount = Object.values(
				useExplorerStore.getState().filePanes,
			).filter((p) => p.isDirty).length;
			const openedCount =
				usePtyActivityStore.getState().openedWorkspaceIds.size;
			switch (decideWindowClose(dirtyPaneCount, openedCount)) {
				case "save-confirm":
					setAppCloseRequested(true);
					return;
				case "workspace-confirm":
					setWorkspaceCloseRequested(true);
					return;
				default:
					await proceedWithClose();
			}
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [proceedWithClose]);

	// Mirror this Window's Opened-workspace count into Rust so the quit
	// confirmation can sum across all Windows. usePtyActivityStore is a vanilla
	// store (no subscribeWithSelector), so this listener intentionally runs on
	// every PTY tick — that's fine: the body is just a Set.size read + integer
	// compare, and the `last` guard means we only issue the IPC when the count
	// actually changes. See ADR-0016.
	useEffect(() => {
		let last = -1;
		const report = (size: number) => {
			if (size === last) return;
			last = size;
			windowSession.reportOpenedWorkspaceCount(size).catch(() => {});
		};
		report(usePtyActivityStore.getState().openedWorkspaceIds.size);
		return usePtyActivityStore.subscribe((state) => {
			report(state.openedWorkspaceIds.size);
		});
	}, []);

	// Settings menu is now handled entirely in Rust — it opens the singleton
	// `settings` window via window_management::open_or_focus_settings_window.
	// No frontend listener needed in profile windows for that path.

	// Listen for native menu "Switch Profile" submenu clicks.
	useEffect(() => {
		const unlisten = listen<string>("switch-profile-request", (event) => {
			requestSwitchProfile(event.payload).catch(() => {});
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Refresh the ownership map whenever any window opens/closes/switches
	// profile so the Settings panel's disabled-states stay accurate.
	useEffect(() => {
		const refresh = () => {
			useProfileStore
				.getState()
				.refreshOwnershipMap()
				.catch(() => {});
		};
		const unlisten = listen("profile-ownership-changed", refresh);
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// A profile rename (or create/delete/reorder) in any window — typically
	// the Settings window — needs to update this window's profile list AND
	// re-apply the window title from the (possibly renamed) active profile.
	useEffect(() => {
		const unlisten = listen("profiles-changed", () => {
			useProfileStore
				.getState()
				.refreshProfiles()
				.catch(() => {});
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
		registerAction("copy", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) copyTerminalSelection(paneId);
		});
		registerAction("paste", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) void pasteIntoTerminal(paneId);
		});
		registerAction("navigate-up", () => navigatePane("up"));
		registerAction("navigate-down", () => navigatePane("down"));
		registerAction("navigate-left", () => navigatePane("left"));
		registerAction("navigate-right", () => navigatePane("right"));
		registerAction("command-palette", () => {
			setFileSearchOpen(false);
			setPaletteOpen((v) => !v);
		});
		registerAction("open-file-search", () => {
			setPaletteOpen(false);
			setFileSearchOpen((v) => !v);
		});
		registerAction("open-settings", () => {
			setPaletteOpen(false);
			// Settings is now a singleton OS window (ADR-0007). The Rust
			// command opens or focuses it; the panel renders inside that
			// dedicated window, not as a modal here.
			invoke("open_settings_window").catch(() => {});
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
		registerAction("toggle-right-sidebar-git", () => {
			useWindowUiStore.getState().toggleRightSidebarTab("git");
		});
		registerAction("toggle-right-sidebar-explorer", () => {
			useWindowUiStore.getState().toggleRightSidebarTab("explorer");
		});
		registerAction("toggle-right-sidebar-notes", () => {
			useWindowUiStore.getState().toggleRightSidebarTab("notes");
		});
		registerAction("toggle-markdown-preview", () => {
			const paneId = useWorkspaceStore.getState().focusedPaneId;
			if (paneId) toggleMarkdownPreviewForPane(paneId);
		});
		registerAction("search-in-workspace", () => {
			useWindowUiStore.getState().toggleRightSidebarTab("search");
		});
		registerAction("toggle-statistics-overlay", () => {
			useWindowUiStore.getState().toggleStatisticsOverlay();
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
							className="flex items-center justify-center flex-1 min-w-0 overflow-hidden px-4"
							style={{
								color: "var(--fg-secondary)",
								background: "var(--ambient-glow-top), var(--bg-primary)",
							}}
						>
							<div className="text-center max-w-full break-words">
								<div
									className="text-2xl mb-3 font-medium"
									style={{ color: "var(--accent)" }}
								>
									Abundio
								</div>
								<div className="text-base">
									{workspaces.length > 0
										? "Create or select a workspace to get started"
										: "Create a workspace to get started"}
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
									data-workspace-active={isActive ? "true" : "false"}
									className="absolute flex flex-col"
									style={{
										top: TITLEBAR_HEIGHT + OVERVIEW_BAR_HEIGHT,
										left: 0,
										right: 0,
										bottom: 0,
										// Paint the ambient gradient on the whole region (tab bar +
										// content) so a single top-anchored glow runs through both;
										// the tab bar, tabs, and content area below are transparent
										// and reveal it.
										background: "var(--ambient-glow-top), var(--bg-primary)",
										visibility: isActive ? "visible" : "hidden",
										pointerEvents: isActive ? "auto" : "none",
									}}
								>
									<div
										className="flex items-end shrink-0"
										style={{
											height: 38,
											// Transparent so the gradient (painted on the parent) shows
											// through the tab bar; the TabBar strip is transparent too.
											backgroundColor: "transparent",
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
									<div
										className="flex-1 min-h-0 relative"
										style={{
											// Transparent — the gradient is painted on the parent
											// workspace container so it spans the tab bar too.
											background: "transparent",
										}}
									>
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
					{/* Statistics overlay — covers the workspace stack (terminals stay
					    alive behind it via the portal registry) when open; renders null
					    otherwise. Sits below the Overview bar's z-40 so its toggle stays
					    clickable, above the workspace stack. See ADR-0018. */}
					<StatisticsOverlay
						topOffset={TITLEBAR_HEIGHT + OVERVIEW_BAR_HEIGHT}
					/>
				</div>
				<RightSidebar titlebarHeight={TITLEBAR_HEIGHT} />
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
			{/* Settings is now a dedicated OS-level window (label="settings"),
			    not a modal here. See ADR-0007 + SettingsApp.tsx. */}
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
			{pendingProfileSwitch && (
				<ConfirmDialog
					title={`Switch to "${pendingProfileSwitch.targetProfileName}"?`}
					message={`This will close ${pendingProfileSwitch.openedWorkspaceCount} opened workspace${pendingProfileSwitch.openedWorkspaceCount === 1 ? "" : "s"} in the current profile and terminate any running agents and PTY processes.`}
					confirmLabel="Switch profile"
					confirmVariant="danger"
					onConfirm={() => {
						confirmProfileSwitch().catch(() => {});
					}}
					onCancel={cancelProfileSwitch}
				/>
			)}
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
			{workspaceCloseRequested &&
				(() => {
					const n = openedWorkspaceIds.size;
					return (
						<ConfirmDialog
							title="Close window?"
							message={`You have ${n} opened workspace${
								n === 1 ? "" : "s"
							} in this window with running agents and terminal processes. Closing the window will terminate them.`}
							confirmLabel="Close window"
							confirmVariant="danger"
							onConfirm={() => {
								setWorkspaceCloseRequested(false);
								proceedWithClose().catch(() => {});
							}}
							onCancel={() => setWorkspaceCloseRequested(false)}
						/>
					);
				})()}
			<DragPanePreview />
			<UpdatePrompt />
		</div>
	);
}
