import { useCallback, useEffect, useRef, useState } from "react";
import { pty } from "../../lib/ipc";
import {
	getTerminal,
	createTerminal,
	attachTerminal,
	detachTerminal,
} from "../../lib/terminalManager";
import { useSettingsStore } from "../../stores/settingsStore";
import { getTheme } from "../../lib/themes";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneContextMenu, type ContextMenuItem } from "./PaneContextMenu";
import { SearchBar } from "./SearchBar";
import "@xterm/xterm/css/xterm.css";

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
	const { fontFamily, fontSize, theme: themeName } = useSettingsStore();
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const searchPaneId = useSessionStore((s) => s.searchPaneId);
	const toggleSearch = useSessionStore((s) => s.toggleSearch);
	const searchOpen = searchPaneId === paneId;

	useEffect(() => {
		if (!containerRef.current) return;

		let resizeTimer: ReturnType<typeof setTimeout>;
		let resizeObserver: ResizeObserver | null = null;
		let cancelled = false;

		const setup = async () => {
			if (!containerRef.current) return;

			const existing = getTerminal(paneId);
			if (existing) {
				// Reattach existing terminal to new container
				attachTerminal(paneId, containerRef.current);
			} else {
				// Create new terminal (waits for font to load)
				const currentTheme = getTheme(themeName);
				await createTerminal(paneId, initialPtyId, cwd, containerRef.current, {
					fontSize,
					fontFamily,
					theme: currentTheme.terminal,
				});
			}

			if (cancelled) return;

			// Resize observer for this container
			const managed = getTerminal(paneId);
			resizeObserver = new ResizeObserver(() => {
				const el = containerRef.current;
				if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
				if (!managed) return;
				managed.fitAddon.fit();
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					if (managed.ptyId) {
						pty.resize(managed.ptyId, managed.term.cols, managed.term.rows);
					}
				}, 100);
			});
			if (containerRef.current) {
				resizeObserver.observe(containerRef.current);
			}
		};

		setup();

		return () => {
			cancelled = true;
			clearTimeout(resizeTimer);
			resizeObserver?.disconnect();
			// Detach to offscreen — don't destroy
			detachTerminal(paneId);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [paneId]);

	useEffect(() => {
		if (isFocused) {
			getTerminal(paneId)?.term.focus();
		}
	}, [isFocused, paneId]);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			onFocus();
			setContextMenu({ x: e.clientX, y: e.clientY });
		},
		[onFocus],
	);

	const handleCopy = useCallback(() => {
		const managed = getTerminal(paneId);
		if (!managed) return;
		const selection = managed.term.getSelection();
		if (selection) {
			navigator.clipboard.writeText(selection);
		}
	}, [paneId]);

	const handlePaste = useCallback(async () => {
		const managed = getTerminal(paneId);
		const text = await navigator.clipboard.readText();
		if (text && managed?.ptyId) {
			pty.write(managed.ptyId, text);
		}
	}, [paneId]);

	const handleClear = useCallback(() => {
		getTerminal(paneId)?.term.clear();
	}, [paneId]);

	const searchAddon = getTerminal(paneId)?.searchAddon ?? null;

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
				padding: "8px 0 0 8px",
				overflow: "hidden",
				boxShadow: "none",
				background: "var(--bg-primary)",
			}}
			onFocus={onFocus}
			onMouseDown={onFocus}
			onContextMenu={handleContextMenu}
		>
			{searchOpen && searchAddon && (
				<SearchBar
					searchAddon={searchAddon}
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
