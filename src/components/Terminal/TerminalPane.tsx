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
import { PromptBar } from "./PromptBar";
import { processOutput, type ShellMeta } from "../../lib/oscParser";
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
	const outputRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const activePtyIdRef = useRef(initialPtyId);
	const { fontFamily, fontSize, theme: themeName } = useSettingsStore();
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const searchPaneId = useSessionStore((s) => s.searchPaneId);
	const toggleSearch = useSessionStore((s) => s.toggleSearch);
	const searchOpen = searchPaneId === paneId;

	// Dual-mode state: 'normal' (prompt bar) or 'passthrough' (full terminal)
	const [mode, setMode] = useState<"normal" | "passthrough">("normal");
	const [shellMeta, setShellMeta] = useState<ShellMeta | null>(null);
	// Loading state: hide terminal until shell hooks are ready (first OSC meta received)
	const [initializing, setInitializing] = useState(true);
	const initReceivedRef = useRef(false);
	// Track last executed command to strip shell echo from PTY output
	const pendingEchoRef = useRef<string | null>(null);

	useEffect(() => {
		if (!outputRef.current) return;

		const currentTheme = getTheme(themeName);
		const term = new Terminal({
			fontSize,
			fontFamily,
			cursorBlink: true,
			allowProposedApi: true,
			theme: currentTheme.terminal,
			disableStdin: true, // Start in normal mode: xterm is output-only
		});

		const fitAddon = new FitAddon();
		const searchAddon = new SearchAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(searchAddon);
		term.loadAddon(new WebLinksAddon());
		searchAddonRef.current = searchAddon;
		fitAddonRef.current = fitAddon;
		term.open(outputRef.current);

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
				// Replay persisted scrollback, stripping init noise.
				// Init regions are delimited by \x1b]7338;init-begin\x07 (start)
				// and the next \x1b]7337;...}\x07 (end). Strip all such regions
				// plus any remaining OSC 7337 metadata sequences.
				const logData = await pty.readLog(paneId);
				if (logData) {
					const logText = new TextDecoder("latin1").decode(logData);
					const cleaned = logText
						.replace(/\x1b\]7338;init-begin\x07[\s\S]*?\x1b\]7337;[^\x07]*\x07/g, "")
						.replace(/\x1b\]7337;[^\x07]*\x07/g, "");
					if (cleaned.length > 0) {
						const encoder = new TextEncoder();
						term.write(encoder.encode(cleaned));
					}
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

			// Input: terminal → PTY (only active in passthrough mode)
			term.onData((data) => {
				if (term.options.disableStdin === false) {
					pty.write(currentPtyId, data);
				}
			});

			// Output: PTY → terminal (binary) with OSC parsing
			const unlistenOutput = await pty.onOutput(currentPtyId, (data) => {
				const result = processOutput(data);

				// Update shell metadata if present
				if (result.meta) {
					setShellMeta(result.meta);

					// First meta received: shell hooks are ready — reveal the terminal
					if (!initReceivedRef.current) {
						initReceivedRef.current = true;
						setInitializing(false);
						fitAddon.fit();
						pty.resize(currentPtyId, term.cols, term.rows);
					}
				}

				// Don't write to terminal while still initializing (suppress hook setup noise)
				if (!initReceivedRef.current) {
					return;
				}

				// Strip echoed command from PTY output (shell echoes despite stty -echo in some cases)
				if (pendingEchoRef.current !== null) {
					const text = new TextDecoder("latin1").decode(result.cleaned);
					const cmd = pendingEchoRef.current;
					pendingEchoRef.current = null;
					// The echo typically appears as the command text possibly preceded by
					// the PS1 space and followed by \r\n
					const echoPattern = new RegExp(
						`^\\s*${cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n?`
					);
					const stripped = text.replace(echoPattern, "");
					if (stripped !== text) {
						const encoder = new TextEncoder();
						result.cleaned = encoder.encode(stripped);
					}
				}

				// Handle alternate screen mode transitions
				if (result.altScreen === "enter") {
					setMode("passthrough");
					term.options.disableStdin = false;
					term.options.cursorBlink = true;
					requestAnimationFrame(() => {
						fitAddon.fit();
						pty.resize(currentPtyId, term.cols, term.rows);
					});
				} else if (result.altScreen === "exit") {
					setMode("normal");
					term.options.disableStdin = true;
					requestAnimationFrame(() => {
						fitAddon.fit();
						pty.resize(currentPtyId, term.cols, term.rows);
					});
				}

				// Write cleaned output to terminal (OSC sequences stripped)
				term.write(result.cleaned);
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
				const el = outputRef.current;
				if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
				fitAddon.fit();
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					pty.resize(currentPtyId, term.cols, term.rows);
				}, 100);
			});
			resizeObserver.observe(outputRef.current!);

			// Cleanup: dispose UI resources but do NOT kill the PTY.
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

	// Focus management: in normal mode focus the prompt bar input, in passthrough focus xterm
	useEffect(() => {
		if (isFocused && mode === "passthrough") {
			termRef.current?.focus();
		}
	}, [isFocused, mode]);

	// Refit terminal when mode changes (prompt bar shows/hides changes output area height)
	useEffect(() => {
		requestAnimationFrame(() => {
			fitAddonRef.current?.fit();
		});
	}, [mode]);

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

	// Write styled command to xterm with a visual separator, then send to PTY
	const handleExecute = useCallback((command: string) => {
		const term = termRef.current;
		const currentPtyId = activePtyIdRef.current;
		if (!term || !currentPtyId) return;

		// Draw a thin separator line using underlined spaces spanning the full width,
		// then the command in near-white on the next line.
		// \x1b[4m = underline, \x1b[38;5;238m = dark gray underline color
		// \x1b[58;5;238m = underline color (SGR 58, supported by xterm.js 5+)
		// \x1b[38;5;252m = near-white text, \x1b[0m = reset
		const sep = `\x1b[4m\x1b[58;5;238m${" ".repeat(term.cols)}\x1b[0m`;
		term.write(`\r\n${sep}\r\n\x1b[38;5;252m$ ${command}\x1b[0m\r\n`);

		// Flag to strip the echoed command from the next PTY output
		pendingEchoRef.current = command;

		// Send command to PTY
		pty.write(currentPtyId, `${command}\r`);
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
			className="w-full h-full relative flex flex-col"
			style={{
				padding: 0,
				overflow: "hidden",
				boxShadow: isFocused ? "0 0 0 1px var(--accent)" : "none",
			}}
			onFocus={onFocus}
			onMouseDown={onFocus}
			onContextMenu={handleContextMenu}
		>
			{/* Loading overlay — shown while shell hooks are initializing */}
			{initializing && (
				<div
					style={{
						position: "absolute",
						inset: 0,
						zIndex: 5,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						background: "var(--bg-primary)",
						gap: 16,
					}}
				>
					<div
						style={{
							width: 24,
							height: 24,
							border: "2px solid var(--bg-tertiary)",
							borderTopColor: "var(--accent)",
							borderRadius: "50%",
							animation: "abundio-spin 0.8s linear infinite",
						}}
					/>
					<span
						style={{
							color: "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
							fontSize: 12,
							letterSpacing: "0.05em",
						}}
					>
						Initializing shell...
					</span>
				</div>
			)}

			{/* Terminal output area */}
			<div
				ref={outputRef}
				style={{
					flex: 1,
					minHeight: 0,
					overflow: "hidden",
				}}
			/>

			{/* Divider line — only in normal mode */}
			{mode === "normal" && !initializing && (
				<div
					style={{
						height: 1,
						background: "var(--border)",
						flexShrink: 0,
					}}
				/>
			)}

			{/* Fixed prompt bar — only in normal mode */}
			{mode === "normal" && !initializing && (
				<PromptBar
					meta={shellMeta}
					ptyId={activePtyIdRef.current}
					isFocused={isFocused}
					onExecute={handleExecute}
				/>
			)}

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
