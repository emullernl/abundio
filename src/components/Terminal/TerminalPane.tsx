import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { pty } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { PaneContextMenu, type ContextMenuItem } from "./PaneContextMenu";
import "@xterm/xterm/css/xterm.css";

interface Props {
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
	const activePtyIdRef = useRef(initialPtyId);
	const { fontFamily, fontSize } = useSettingsStore();
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const term = new Terminal({
			fontSize,
			fontFamily,
			cursorBlink: true,
			allowProposedApi: true,
			theme: {
				background: "#0D1117",
				foreground: "#E6EDF3",
				cursor: "#58D5BA",
				selectionBackground: "#264F78",
				black: "#484F58",
				red: "#FF7B72",
				green: "#3FB950",
				yellow: "#D29922",
				blue: "#58A6FF",
				magenta: "#BC8CFF",
				cyan: "#58D5BA",
				white: "#E6EDF3",
				brightBlack: "#6E7681",
				brightRed: "#FFA198",
				brightGreen: "#56D364",
				brightYellow: "#E3B341",
				brightBlue: "#79C0FF",
				brightMagenta: "#D2A8FF",
				brightCyan: "#7EE2CC",
				brightWhite: "#FFFFFF",
			},
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(new SearchAddon());
		term.loadAddon(new WebLinksAddon());
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

		async function initPty() {
			if (!currentPtyId) {
				currentPtyId = await pty.spawn(cwd, term.cols, term.rows);
				activePtyIdRef.current = currentPtyId;
			}

			// Input: terminal → PTY
			term.onData((data) => {
				pty.write(currentPtyId, data);
			});

			// Output: PTY → terminal (binary)
			const unlistenOutput = await pty.onOutput(currentPtyId, (data) => {
				term.write(data);
			});

			// Resize: debounced
			let resizeTimer: ReturnType<typeof setTimeout>;
			const resizeObserver = new ResizeObserver(() => {
				fitAddon.fit();
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					pty.resize(currentPtyId, term.cols, term.rows);
				}, 100);
			});
			resizeObserver.observe(containerRef.current!);

			// Store cleanup references
			return () => {
				unlistenOutput();
				clearTimeout(resizeTimer);
				resizeObserver.disconnect();
				pty.kill(currentPtyId);
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
