import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { pty } from "../../lib/ipc";
import { registerTarget, unregisterTarget } from "../../lib/portalRegistry";
import { getTerminal, resetTerminal } from "../../lib/terminalManager";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
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
			style={{ backgroundColor: "var(--bg-primary)" }}
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

	// @ts-expect-error intentionally unused — Zustand subscription triggers re-render
	// biome-ignore lint/correctness/noUnusedVariables: subscription trigger for re-render on tab switch
	const activeTabId = useWorkspaceStore((s) => {
		const activeWorkspaceId = s.activeWorkspaceId;
		return activeWorkspaceId ? s.activeTabByWorkspace[activeWorkspaceId] : null;
	});

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

	const handleReset = useCallback(() => {
		resetTerminal(paneId);
	}, [paneId]);

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
		{ label: "Copy", shortcut: "⌘C", onClick: handleCopy },
		{ label: "Paste", shortcut: "⌘V", onClick: handlePaste },
		{ separator: true },
		{ label: "Find", shortcut: "⇧⌘F", onClick: toggleSearch },
		{ label: "Clear Terminal", onClick: handleClear },
		{ label: "Reset Terminal", onClick: handleReset },
		{ separator: true },
		{
			label: "Agents",
			disabled: isAgentMode || enabledAgents.length === 0,
			submenu: agentSubmenu,
		},
		{ separator: true },
		{ label: "Split Right", shortcut: "⇧⌘V", onClick: onSplitVertical },
		{ label: "Split Down", shortcut: "⇧⌘H", onClick: onSplitHorizontal },
		{ separator: true },
		{ label: "Close Pane", shortcut: "⇧⌘W", onClick: onClose },
	];

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: terminal pane container with context menu and focus handling
		<div
			ref={containerRef}
			className="w-full h-full relative flex flex-col"
			style={{
				padding: "0 0 0 8px",
				overflow: "hidden",
				boxShadow: "none",
				background: "var(--bg-primary)",
				opacity: isFocused ? 1 : 0.75,
				transition: "opacity 150ms ease",
			}}
			onFocus={handleFocus}
			onMouseDown={handleFocus}
			onContextMenu={handleContextMenu}
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
		</div>
	);
}
