import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { pty } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { getTheme } from "../../lib/themes";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneContextMenu, type ContextMenuItem } from "./PaneContextMenu";
import { SearchBar } from "./SearchBar";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type { PaneNode } from "../../lib/types";
import "@xterm/xterm/css/xterm.css";

function setPtyIdInLayout(node: PaneNode, targetPaneId: string, ptyId: string): PaneNode {
	if (node.type === "terminal") {
		return node.id === targetPaneId ? { ...node, ptyId } : node;
	}
	return {
		...node,
		first: setPtyIdInLayout(node.first, targetPaneId, ptyId),
		second: setPtyIdInLayout(node.second, targetPaneId, ptyId),
	};
}

interface Props {
	paneId: string;
	ptyId: string;
	cwd: string;
	isFocused: boolean;
	onFocus: () => void;
	onSplitHorizontal: () => void;
	onSplitVertical: () => void;
	onClose: () => void;
	onMaximize: () => void;
	isMaximized: boolean;
}

export function TerminalPane({
	paneId,
	ptyId: initialPtyId,
	cwd,
	isFocused,
	onFocus,
	onSplitHorizontal,
	onSplitVertical,
	onClose,
	onMaximize,
	isMaximized,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const activePtyIdRef = useRef(initialPtyId);
	const { fontFamily, fontSize, theme: themeName } = useSettingsStore();
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const searchPaneId = useSessionStore((s) => s.searchPaneId);
	const toggleSearch = useSessionStore((s) => s.toggleSearch);
	const searchOpen = searchPaneId === paneId;

	useEffect(() => {
		if (!containerRef.current) return;

		const currentTheme = getTheme(themeName);
		const term = new Terminal({
			fontSize,
			fontFamily,
			cursorBlink: true,
			allowProposedApi: true,
			theme: currentTheme.terminal,
		});

		const fitAddon = new FitAddon();
		const searchAddon = new SearchAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(searchAddon);
		term.loadAddon(new WebLinksAddon());
		searchAddonRef.current = searchAddon;
		term.open(containerRef.current);

		// GPU acceleration — fallback to canvas if WebGL2 unavailable
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// Canvas renderer is the default — no action needed
		}

		fitAddon.fit();
		termRef.current = term;

		// Spawn PTY if needed (empty ptyId means "spawn on activate")
		let currentPtyId = initialPtyId;

		const { setPtyStatus } = useSessionStore.getState();

		async function initPty() {
			if (!currentPtyId) {
				// Replay persisted scrollback from a previous session before spawning a new PTY
				const logData = await pty.readLog(paneId);
				if (logData) {
					term.write(logData);
				}

				currentPtyId = await pty.spawn(cwd, term.cols, term.rows, undefined, paneId);
				activePtyIdRef.current = currentPtyId;

				// Update the layout tree with the real ptyId so status tracking works
				const store = useSessionStore.getState();
				const session = store.getActiveSession();
				const layout = store.getActiveLayout();
				if (session && layout) {
					const updated = setPtyIdInLayout(layout, paneId, currentPtyId);
					store.updateLayoutLocal(session.id, updated);
				}
			}

			// Mark as running
			setPtyStatus(currentPtyId, { type: "running" });

			// Input: terminal → PTY
			term.onData((data) => {
				pty.write(currentPtyId, data);
			});

			// Output: PTY → terminal (binary)
			const unlistenOutput = await pty.onOutput(currentPtyId, (data) => {
				term.write(data);
			});

			// Status: track process lifecycle
			const unlistenStatus = await pty.onStatus(currentPtyId, (status) => {
				useSessionStore.getState().setPtyStatus(currentPtyId, status);
				if (status.type === "exited") {
					const exitMsg = status.code === 0 ? "exited" : `exited with code ${status.code}`;
					try {
						sendNotification({ title: "Abundio", body: `Process ${exitMsg}` });
					} catch {
						// Notifications may not be permitted
					}
				}
			});

			// Resize: debounced (skip when hidden — display:none gives 0 dimensions)
			let resizeTimer: ReturnType<typeof setTimeout>;
			const resizeObserver = new ResizeObserver(() => {
				const el = containerRef.current;
				if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
				fitAddon.fit();
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					pty.resize(currentPtyId, term.cols, term.rows);
				}, 100);
			});
			resizeObserver.observe(containerRef.current!);

			// Cleanup: dispose UI resources but do NOT kill the PTY.
			// PTY processes are killed explicitly via closePane/deleteSession.
			// Killing here would terminate the shell when React remounts
			// the component during split/layout changes.
			return () => {
				unlistenOutput();
				unlistenStatus();
				clearTimeout(resizeTimer);
				resizeObserver.disconnect();
				term.dispose();
			};
		}

		const cleanupPromise = initPty();

		return () => {
			cleanupPromise.then((cleanup) => cleanup?.());
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd]);

	useEffect(() => {
		if (isFocused) termRef.current?.focus();
	}, [isFocused]);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			onFocus();
			setContextMenu({ x: e.clientX, y: e.clientY });
		},
		[onFocus],
	);

	const handleCopy = useCallback(() => {
		const term = termRef.current;
		if (!term) return;
		const selection = term.getSelection();
		if (selection) {
			navigator.clipboard.writeText(selection);
		}
	}, []);

	const handlePaste = useCallback(async () => {
		const text = await navigator.clipboard.readText();
		if (text && activePtyIdRef.current) {
			pty.write(activePtyIdRef.current, text);
		}
	}, []);

	const handleClear = useCallback(() => {
		termRef.current?.clear();
	}, []);

	const contextMenuItems: ContextMenuItem[] = [
		{ label: "Copy", shortcut: "⌘C", onClick: handleCopy },
		{ label: "Paste", shortcut: "⌘V", onClick: handlePaste },
		{ separator: true },
		{ label: "Find", shortcut: "⇧⌘F", onClick: toggleSearch },
		{ label: "Clear Terminal", onClick: handleClear },
		{ separator: true },
		{ label: "Split Right", shortcut: "⇧⌘V", onClick: onSplitVertical },
		{ label: "Split Down", shortcut: "⇧⌘H", onClick: onSplitHorizontal },
		{ separator: true },
		{
			label: isMaximized ? "Restore Pane" : "Maximize Pane",
			shortcut: "⇧⌘M",
			onClick: onMaximize,
		},
		{ label: "Close Pane", shortcut: "⇧⌘W", onClick: onClose },
	];

	return (
		<div
			ref={containerRef}
			className="w-full h-full relative"
			style={{
				padding: 0,
				overflow: "hidden",
				boxShadow: isFocused ? "0 0 0 1px var(--accent)" : "none",
			}}
			onFocus={onFocus}
			onMouseDown={onFocus}
			onContextMenu={handleContextMenu}
		>
			{searchOpen && searchAddonRef.current && (
				<SearchBar
					searchAddon={searchAddonRef.current}
					onClose={toggleSearch}
				/>
			)}
			{contextMenu && (
				<PaneContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={contextMenuItems}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</div>
	);
}
