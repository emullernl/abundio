import { useCallback, useEffect, useRef, useState } from "react";
import { pty } from "../../lib/ipc";
import { getTerminal } from "../../lib/terminalManager";
import { registerTarget, unregisterTarget } from "../../lib/portalRegistry";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneContextMenu, type ContextMenuItem } from "./PaneContextMenu";
import { SearchBar } from "./SearchBar";
import { TerminalTitleBar } from "./TerminalTitleBar";

interface Props {
	paneId: string;
	isFocused: boolean;
	onFocus: () => void;
	onSplitHorizontal: () => void;
	onSplitVertical: () => void;
	onClose: () => void;
	onMaximize: () => void;
	isMaximized: boolean;
}

export function TerminalSlot({
	paneId,
	isFocused,
	onFocus,
	onSplitHorizontal,
	onSplitVertical,
	onClose,
	onMaximize,
	isMaximized,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const searchPaneId = useSessionStore((s) => s.searchPaneId);
	const toggleSearch = useSessionStore((s) => s.toggleSearch);
	const searchOpen = searchPaneId === paneId;

	useEffect(() => {
		if (!innerRef.current) return;
		registerTarget(paneId, innerRef.current);
		return () => unregisterTarget(paneId);
	}, [paneId]);

	const activeView = useSessionStore((s) => {
		const activeSessionId = s.activeSessionId;
		return activeSessionId ? s.activeView[activeSessionId] ?? "terminal" : "terminal";
	});
	const activeTabId = useSessionStore((s) => {
		const activeSessionId = s.activeSessionId;
		return activeSessionId ? s.activeTabBySession[activeSessionId] : null;
	});

	useEffect(() => {
		if (isFocused && activeView === "terminal") {
			// Double rAF: first waits for display:none→block commit, second for layout
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					getTerminal(paneId)?.term.focus();
				});
			});
		}
	}, [isFocused, paneId, activeView, activeTabId]);

	const handleFocus = useCallback(() => {
		onFocus();
		const managed = getTerminal(paneId);
		if (managed) {
			managed.suppressActivity = false;
		}
	}, [onFocus, paneId]);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			handleFocus();
			setContextMenu({ x: e.clientX, y: e.clientY });
		},
		[handleFocus],
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
			className="w-full h-full relative flex flex-col"
			style={{
				padding: "0 0 0 8px",
				overflow: "hidden",
				boxShadow: "none",
				background: "var(--bg-primary)",
			}}
			onFocus={handleFocus}
			onMouseDown={handleFocus}
			onContextMenu={handleContextMenu}
		>
			<TerminalTitleBar paneId={paneId} />
			<div
				ref={innerRef}
				className="w-full flex-1 min-h-0"
				style={{ overflow: "hidden" }}
			/>
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
