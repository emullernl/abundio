import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { useDragPaneStore } from "../../lib/dragPaneStore";
import { pty } from "../../lib/ipc";
import { sc } from "../../lib/platform";
import { registerTarget, unregisterTarget } from "../../lib/portalRegistry";
import {
	copyTerminalSelection,
	pasteIntoTerminal,
} from "../../lib/terminalClipboard";
import {
	getPaneRevision,
	getTerminal,
	resetTerminal,
	subscribePaneRevision,
} from "../../lib/terminalManager";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FileDropHighlight } from "../FileDropHighlight";
import { PaneDropIndicator } from "../PaneDropIndicator";
import { DebugActivityMeter } from "./DebugActivityMeter";
import { type ContextMenuItem, PaneContextMenu } from "./PaneContextMenu";
import { SearchBar } from "./SearchBar";
import { TerminalTitleBar } from "./TerminalTitleBar";

function TerminalLoader({ paneId }: { paneId: string }) {
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		const interval = setInterval(() => {
			const managed = getTerminal(paneId);
			if (managed?.ready && managed?.settled) {
				setVisible(false);
				clearInterval(interval);
			}
		}, 250);

		// Safety net: hide loader after 5s even if ready never fires
		const timeout = setTimeout(() => {
			setVisible(false);
			clearInterval(interval);
		}, 5000);

		return () => {
			clearInterval(interval);
			clearTimeout(timeout);
		};
	}, [paneId]);

	if (!visible) return null;

	return (
		<div
			className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"
			// Transparent — the pane (slot + xterm canvas) is already transparent, so
			// this reveals the SINGLE continuous workspace gradient behind all panes.
			// Painting the gradient on the loader itself re-centers it per-pane
			// (`at 50% 100%` is relative to each box), so it wouldn't line up across
			// splits; staying transparent keeps the illusion seamless. The dots float
			// on top; the un-painted terminal beneath is transparent too, so there's
			// nothing opaque left to mask.
			style={{ background: "transparent" }}
		>
			<div className="flex flex-col items-center gap-3">
				<div className="flex gap-[3px]">
					{[0, 1, 2, 3, 4].map((i) => (
						<div
							key={i}
							style={{
								width: 3,
								height: 14,
								borderRadius: 1,
								backgroundColor: "var(--accent)",
								opacity: 0.15,
								animation: `terminal-bar-wave 1.2s ease-in-out ${i * 0.12}s infinite`,
							}}
						/>
					))}
				</div>
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 10,
						color: "var(--fg-secondary)",
						opacity: 0.4,
						letterSpacing: "0.08em",
						textTransform: "uppercase",
					}}
				>
					initializing
				</span>
			</div>
		</div>
	);
}

interface Props {
	paneId: string;
	agentId?: string;
	isFocused: boolean;
	onFocus: () => void;
	onSplitHorizontal: () => void;
	onSplitVertical: () => void;
	onClose: () => void;
}

export function TerminalSlot({
	paneId,
	agentId,
	isFocused,
	onFocus,
	onSplitHorizontal,
	onSplitVertical,
	onClose,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const searchPaneId = useWorkspaceStore((s) => s.searchPaneId);
	const toggleSearch = useWorkspaceStore((s) => s.toggleSearch);
	const searchOpen = searchPaneId === paneId;
	const debugMeterEnabled = useSettingsStore((s) => s.debugActivityMeter);

	useEffect(() => {
		if (!innerRef.current) return;
		registerTarget(paneId, innerRef.current);
		return () => unregisterTarget(paneId);
	}, [paneId]);

	// Re-render only when THIS pane's ManagedTerminal is created / gets its ptyId
	// / becomes ready, so derived values (searchAddon, ptyIdForPane) update without
	// subscribing to global tab/workspace state.
	useSyncExternalStore(
		useCallback(
			(onChange) => subscribePaneRevision(paneId, onChange),
			[paneId],
		),
		useCallback(() => getPaneRevision(paneId), [paneId]),
		useCallback(() => getPaneRevision(paneId), [paneId]),
	);

	useEffect(() => {
		if (!isFocused) return;
		// Poll until the terminal exists and is ready, then focus. Polling
		// handles two cases uniformly: a freshly-created tab where the
		// ManagedTerminal hasn't been built yet, and a tab switch where the
		// container just transitioned from display:none to block.
		const tryFocus = () => {
			const managed = getTerminal(paneId);
			if (managed?.ready) {
				managed.term.focus();
				return true;
			}
			return false;
		};
		if (tryFocus()) return;
		const interval = setInterval(() => {
			if (tryFocus()) clearInterval(interval);
		}, 16);
		const timeout = setTimeout(() => clearInterval(interval), 5000);
		return () => {
			clearInterval(interval);
			clearTimeout(timeout);
		};
	}, [isFocused, paneId]);

	const handleFocus = useCallback(() => {
		onFocus();
		const managed = getTerminal(paneId);
		if (managed) {
			managed.suppressActivity = false;
		}
	}, [onFocus, paneId]);

	// A deliberate left-click into the terminal screen counts as the user
	// engaging with a waiting agent, so clear its sky-blue "waiting" dot to idle
	// — the same effect ESC has in terminalManager's onData keystroke path.
	// clearWaiting is a no-op unless the pane is actually waiting, so this is
	// safe to call. Two deliberate restrictions:
	//   • We do NOT fold this into handleFocus: that also fires on programmatic
	//     focus (tab switch via the isFocused effect), and switching to a tab
	//     should keep showing its waiting dot, not silently clear it.
	//   • We gate on the click landing inside innerRef (the xterm screen). The
	//     mousedown is bound to the whole pane container so a click anywhere
	//     focuses the pane, but clicks on the title bar — including the start of
	//     a pane drag-reorder — must NOT clear the dot. Right/middle clicks
	//     (context menu, paste) are excluded via the button guard.
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			handleFocus();
			if (e.button !== 0) return;
			if (!innerRef.current?.contains(e.target as Node)) return;
			const ptyId = getTerminal(paneId)?.ptyId;
			if (ptyId) usePtyActivityStore.getState().clearWaiting(ptyId);
		},
		[handleFocus, paneId],
	);

	// Open our own context menu on right-click, and crucially stop the event
	// before xterm.js sees it. xterm registers a `contextmenu` listener on its
	// inner `.xterm` element whose handler moves the hidden input textarea under
	// the cursor and dumps the current selection into it (its support for the
	// browser-native copy/paste menu). On Windows WebView2 that makes a plain
	// right-click paste the clipboard straight into the PTY. We use PaneContextMenu
	// and route clipboard through Tauri, so xterm's handler is pure liability.
	// React's onContextMenu is bubble-phase on the outer container and would run
	// *after* xterm's listener on the descendant element — too late. Register in
	// the capture phase on the container so we run first and stopPropagation()
	// keeps the event from ever reaching xterm.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			handleFocus();
			setContextMenu({ x: e.clientX, y: e.clientY });
		};
		el.addEventListener("contextmenu", handler, true);
		return () => el.removeEventListener("contextmenu", handler, true);
	}, [handleFocus]);

	const handleCopy = useCallback(() => {
		copyTerminalSelection(paneId);
	}, [paneId]);

	const handlePaste = useCallback(() => {
		void pasteIntoTerminal(paneId);
	}, [paneId]);

	const handleClear = useCallback(() => {
		getTerminal(paneId)?.term.clear();
	}, [paneId]);

	const handleReset = useCallback(() => {
		resetTerminal(paneId);
	}, [paneId]);

	const isDragSource = useDragPaneStore(
		(s) => s.isDragging && s.sourcePaneId === paneId,
	);

	const searchAddon = getTerminal(paneId)?.searchAddon ?? null;

	// Agents submenu — launches the selected agent into the current shell by
	// typing its command, mirroring CommandPalette's existing agent flow.
	// Only enabled when this terminal is running a plain shell; once an agent
	// is active we hide the submenu entries to prevent double-launching.
	const agents = useSettingsStore((s) => s.agents);
	const enabledAgents = useMemo(
		() => agents.filter((a) => a.enabled),
		[agents],
	);
	const ptyIdForPane = getTerminal(paneId)?.ptyId ?? null;
	const isAgentMode = usePtyActivityStore((s) =>
		ptyIdForPane
			? s.activities[ptyIdForPane]?.detectionMode === "agent"
			: false,
	);

	const handleLaunchAgent = useCallback(
		(agent: { id: string; command: string; args?: string[] }) => {
			const managed = getTerminal(paneId);
			if (!managed?.ptyId) return;
			const cmd = [agent.command, ...(agent.args ?? [])].join(" ");
			pty.write(managed.ptyId, `${cmd}\n`);
			usePtyActivityStore.getState().setAgentPty(managed.ptyId);
			// Persist the agent identity onto the layout so it re-runs after restart.
			useWorkspaceStore.getState().stampAgentOnPane(paneId, agent.id);
		},
		[paneId],
	);

	const agentSubmenu: ContextMenuItem[] = useMemo(
		() =>
			enabledAgents.map((agent) => {
				const BrandIcon = getAgentIconComponent(agent.id);
				return {
					label: agent.name,
					icon: BrandIcon ? (
						<BrandIcon size={14} />
					) : (
						<FallbackAgentIcon size={14} />
					),
					onClick: () => handleLaunchAgent(agent),
				};
			}),
		[enabledAgents, handleLaunchAgent],
	);

	const contextMenuItems: ContextMenuItem[] = [
		{ label: "Copy", shortcut: sc("⌘C", "Ctrl+Shift+C"), onClick: handleCopy },
		{
			label: "Paste",
			shortcut: sc("⌘V", "Ctrl+Shift+V"),
			onClick: handlePaste,
		},
		{ separator: true },
		{ label: "Find", shortcut: sc("⌘F", "Ctrl+F"), onClick: toggleSearch },
		{ label: "Clear Terminal", onClick: handleClear },
		{ label: "Reset Terminal", onClick: handleReset },
		{ separator: true },
		{
			label: "Agents",
			disabled: isAgentMode || enabledAgents.length === 0,
			submenu: agentSubmenu,
		},
		{ separator: true },
		{
			label: "Split Right",
			shortcut: sc("⇧⌘V", "Ctrl+Alt+V"),
			onClick: onSplitVertical,
		},
		{
			label: "Split Down",
			shortcut: sc("⇧⌘H", "Ctrl+Alt+H"),
			onClick: onSplitHorizontal,
		},
		{ separator: true },
		{
			label: "Close Pane",
			shortcut: sc("⇧⌘W", "Ctrl+Shift+W"),
			onClick: onClose,
		},
	];

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: terminal pane container with context menu and focus handling
		<div
			ref={containerRef}
			className="w-full h-full relative flex flex-col"
			data-pane-id={paneId}
			style={{
				padding: "0 0 0 8px",
				overflow: "hidden",
				boxShadow: "none",
				// Transparent so the workspace's ambient gradient (painted behind
				// the pane tree) shows through the terminal — the xterm canvas is
				// transparent too (see allowTransparency in terminalManager).
				background: "transparent",
				opacity: isDragSource ? 0.35 : isFocused ? 1 : 0.75,
				transition: "opacity 150ms ease",
			}}
			onFocus={handleFocus}
			onMouseDown={handleMouseDown}
		>
			<TerminalTitleBar
				paneId={paneId}
				agentId={agentId}
				onSplitDown={onSplitHorizontal}
				onSplitRight={onSplitVertical}
				onClose={onClose}
			/>
			{debugMeterEnabled && <DebugActivityMeter paneId={paneId} />}
			<TerminalLoader paneId={paneId} />
			<div
				ref={innerRef}
				className="w-full flex-1 min-h-0"
				style={{ overflow: "hidden" }}
			/>
			{searchOpen && searchAddon && (
				<SearchBar searchAddon={searchAddon} onClose={toggleSearch} />
			)}
			{contextMenu && (
				<PaneContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					items={contextMenuItems}
					onClose={() => setContextMenu(null)}
				/>
			)}
			<PaneDropIndicator paneId={paneId} />
			<FileDropHighlight paneId={paneId} />
		</div>
	);
}
