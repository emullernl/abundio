import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSplitPane } from "../hooks/useSplitPane";
import { isAgentPane } from "../lib/firePromptAction";
import { toggleFleetSpotlight, useTargetPaneId } from "../lib/fleetFocus";
import { fuzzyMatch } from "../lib/fuzzyMatch";
import { pty } from "../lib/ipc";
import { triggerAction } from "../lib/keybindings";
import { firePaneAction } from "../lib/promptActionRegistry";
import { actionsForPane, buttonLabel, canFire } from "../lib/promptActions";
import { getTerminal } from "../lib/terminalManager";
import { themeList } from "../lib/themes";
import { addWorktreeTargetId } from "../lib/worktreeGrouping";
import { useProfileStore } from "../stores/profileStore";
import { requestSwitchProfile } from "../stores/profileSwitchConfirmStore";
import { usePromptActionStore } from "../stores/promptActionStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWindowUiStore } from "../stores/windowUiStore";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

interface PaletteItem {
	id: string;
	label: string;
	category: string;
	action: () => void;
	/** Listed but not selectable. Used where an entry exists but cannot run
	 *  right now, so the reason is visible rather than a silent no-op. */
	disabled?: boolean;
}

interface Props {
	open: boolean;
	onClose: () => void;
	onRequestNewWorkspace: () => void;
}

export function CommandPalette({
	open: isOpen,
	onClose,
	onRequestNewWorkspace,
}: Props) {
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const beginWorkspaceSwitch = useWorkspaceStore((s) => s.beginWorkspaceSwitch);
	// In the Fleet Console, pane commands target the Focused tile (ADR-0040).
	const focusedPaneId = useTargetPaneId();
	const inFleet = useWindowUiStore(
		(s) => s.fleetConsoleOpen && !s.statisticsOverlayOpen,
	);
	const spotlightTileId = useWindowUiStore((s) => s.spotlightTileId);
	const profilesList = useProfileStore((s) => s.profiles);
	const activeProfileId = useProfileStore((s) => s.activeProfileId);
	const { setTheme, debugActivityMeter, toggleDebugActivityMeter, agents } =
		useSettingsStore();
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const addWorktreeTarget = useMemo(
		() => addWorktreeTargetId(workspaces, worktreeFacts, activeWorkspaceId),
		[workspaces, worktreeFacts, activeWorkspaceId],
	);
	const focusSweep = useSettingsStore((s) => s.focusSweep);
	const setFocusSweep = useSettingsStore((s) => s.setFocusSweep);
	const promptActionList = usePromptActionStore((s) => s.actions);
	const { splitPane, closePane } = useSplitPane();

	const items = useMemo<PaletteItem[]>(() => {
		const result: PaletteItem[] = [];

		// Workspaces
		for (const s of workspaces) {
			result.push({
				id: `workspace-${s.id}`,
				label: s.name,
				category: "Workspaces",
				action: () => {
					// Picking a Workspace is a request to see it.
					useWindowUiStore.getState().setFleetConsoleOpen(false);
					beginWorkspaceSwitch(s.id);
				},
			});
		}

		// Profiles — flat entries, active one omitted.
		for (const p of profilesList) {
			if (p.id === activeProfileId) continue;
			result.push({
				id: `profile-${p.id}`,
				label: `Switch to Profile: ${p.name}`,
				category: "Profiles",
				action: () => {
					requestSwitchProfile(p.id).catch(() => {});
				},
			});
		}
		result.push({
			id: "action-manage-profiles",
			label: "Manage Profiles…",
			category: "Profiles",
			action: () => {
				// Open the singleton Settings window deep-linked to Profiles.
				invoke("open_settings_window", { section: "profiles" }).catch(() => {});
			},
		});

		// Actions
		result.push({
			id: "action-new-workspace",
			label: "New Workspace",
			category: "Actions",
			action: () => onRequestNewWorkspace(),
		});

		// Offered only when the shortcut would do something — the palette is
		// where the "which Workspace can add a worktree" rule is discoverable.
		// Workspace-view actions are muted in the Fleet Console, so they are not
		// offered there either.
		if (addWorktreeTarget && !inFleet) {
			result.push({
				id: "action-add-worktree",
				label: "Add Worktree…",
				category: "Actions",
				action: () => triggerAction("add-worktree"),
			});
		}

		result.push({
			id: "action-new-task",
			label: "New Task…",
			category: "Actions",
			action: () => triggerAction("new-task"),
		});

		result.push({
			id: "action-toggle-fleet-console",
			label: "Toggle Fleet Console",
			category: "Actions",
			action: () => triggerAction("toggle-fleet-console"),
		});
		if (!inFleet) {
			result.push(
				{
					id: "action-next-workspace",
					label: "Next Opened Workspace",
					category: "Actions",
					action: () => triggerAction("next-workspace"),
				},
				{
					id: "action-prev-workspace",
					label: "Previous Opened Workspace",
					category: "Actions",
					action: () => triggerAction("prev-workspace"),
				},
			);
		}

		if (focusedPaneId && !inFleet) {
			result.push(
				{
					id: "action-split-right",
					label: "Split Right",
					category: "Actions",
					action: () => splitPane(focusedPaneId, "vertical"),
				},
				{
					id: "action-split-down",
					label: "Split Down",
					category: "Actions",
					action: () => splitPane(focusedPaneId, "horizontal"),
				},
				{
					id: "action-next-pane",
					label: "Focus Next Pane",
					category: "Actions",
					action: () => triggerAction("next-pane"),
				},
				{
					id: "action-prev-pane",
					label: "Focus Previous Pane",
					category: "Actions",
					action: () => triggerAction("prev-pane"),
				},
				{
					id: "action-close-pane",
					label: "Close Pane",
					category: "Actions",
					action: () => closePane(focusedPaneId),
				},
			);
		}

		if (focusedPaneId && inFleet) {
			result.push(
				{
					id: "action-next-pane",
					label: "Focus Next Agent",
					category: "Actions",
					action: () => triggerAction("next-pane"),
				},
				{
					id: "action-prev-pane",
					label: "Focus Previous Agent",
					category: "Actions",
					action: () => triggerAction("prev-pane"),
				},
				{
					id: "action-close-pane",
					label: "Close Pane",
					category: "Actions",
					action: () => closePane(focusedPaneId),
				},
				{
					id: "action-fleet-spotlight",
					label:
						spotlightTileId === focusedPaneId
							? "Back to the Grid"
							: "Spotlight This Agent",
					category: "Actions",
					action: () => toggleFleetSpotlight(),
				},
			);
		}

		result.push({
			id: "action-open-settings",
			label: "Open Settings",
			category: "Actions",
			action: () => triggerAction("open-settings"),
		});

		result.push({
			id: "action-toggle-focus-sweep",
			label: focusSweep ? "Turn Off Focus Sweep" : "Turn On Focus Sweep",
			category: "Actions",
			action: () => setFocusSweep(!focusSweep),
		});

		result.push({
			id: "action-toggle-markdown-preview",
			label: "Toggle Markdown Preview",
			category: "Actions",
			action: () => triggerAction("toggle-markdown-preview"),
		});

		// Agents
		if (focusedPaneId) {
			for (const agent of agents.filter((a) => a.enabled)) {
				result.push({
					id: `agent-${agent.id}`,
					label: `Launch ${agent.name}`,
					category: "Agents",
					action: () => {
						const managed = getTerminal(focusedPaneId);
						if (!managed?.ptyId) return;
						const cmd = [agent.command, ...(agent.args || [])].join(" ");
						pty.write(managed.ptyId, `${cmd}\n`);
						usePtyActivityStore.getState().setAgentPty(managed.ptyId);
					},
				});
			}
		}

		// Prompt actions — only for the focused pane, and only when that pane is
		// an agent-mode PTY. Firing one into a shell would type a paragraph at a
		// prompt and press Enter, which is arbitrary shell execution of prompt
		// text, not a wrong-pane annoyance. Scope-filtered the same way the
		// Action bar is, but ignoring Show in bar — the palette is how you reach
		// the ones you keep out of the bar.
		if (focusedPaneId && isAgentPane(getTerminal(focusedPaneId)?.ptyId)) {
			const agentId = (() => {
				const ptyId = getTerminal(focusedPaneId)?.ptyId;
				return ptyId
					? usePtyActivityStore.getState().detectedAgentIds[ptyId]
					: undefined;
			})();
			// Disabled while the agent is Waiting, matching the bar. firePromptAction
			// refuses either way, but without this the entry closes the palette and
			// does nothing — the guard would be invisible on this path.
			const ptyId = getTerminal(focusedPaneId)?.ptyId;
			const waiting = ptyId
				? !canFire(usePtyActivityStore.getState().activities[ptyId]?.state)
				: false;
			for (const action of actionsForPane(promptActionList, agentId, {
				barOnly: false,
			})) {
				result.push({
					id: `prompt-action-${action.id}`,
					label: waiting
						? `${buttonLabel(action)} — agent is waiting for permission`
						: buttonLabel(action),
					category: "Prompt Actions",
					disabled: waiting,
					action: () => firePaneAction(focusedPaneId, action),
				});
			}
		}

		// Debug
		//
		// The Waiting guard on a Prompt action is the one rule a unit test cannot
		// prove: a green test shows the button reads a flag, not that the flag is
		// set when an Agent is really asking permission. Verifying it for real
		// otherwise means coaxing an Agent into a permission prompt every time
		// someone touches this code, which is the step people skip. This drives
		// the same reducer transition the real hook does.
		if (focusedPaneId) {
			result.push({
				id: "action-debug-simulate-waiting",
				label: "Debug: Simulate Agent Waiting",
				category: "Debug",
				action: () => {
					const ptyId = getTerminal(focusedPaneId)?.ptyId;
					if (!ptyId) return;
					usePtyActivityStore.getState().applyHookEvent(ptyId, "waiting");
				},
			});
			result.push({
				id: "action-debug-clear-waiting",
				label: "Debug: Clear Agent Waiting",
				category: "Debug",
				action: () => {
					const ptyId = getTerminal(focusedPaneId)?.ptyId;
					if (!ptyId) return;
					usePtyActivityStore.getState().clearWaiting(ptyId);
				},
			});
		}
		result.push({
			id: "action-toggle-debug-meter",
			label: `Debug Activity Meter: ${debugActivityMeter ? "On" : "Off"}`,
			category: "Debug",
			action: () => toggleDebugActivityMeter(),
		});

		// Themes
		for (const t of themeList()) {
			result.push({
				id: `theme-${t.name}`,
				label: t.displayName,
				category: "Themes",
				action: () => setTheme(t.name),
			});
		}

		return result;
	}, [
		workspaces,
		focusedPaneId,
		inFleet,
		spotlightTileId,
		beginWorkspaceSwitch,
		onRequestNewWorkspace,
		splitPane,
		closePane,
		setTheme,
		debugActivityMeter,
		toggleDebugActivityMeter,
		agents,
		profilesList,
		activeProfileId,
		promptActionList,
		focusSweep,
		setFocusSweep,
		addWorktreeTarget,
	]);

	const filtered = useMemo(() => {
		if (!query) return items;
		return items
			.map((item) => ({ item, score: fuzzyMatch(query, item.label) }))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.map(({ item }) => item);
	}, [items, query]);

	useEffect(() => {
		if (isOpen) {
			setQuery("");
			setSelectedIndex(0);
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [isOpen]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when query changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	// Scroll selected item into view
	useEffect(() => {
		if (!listRef.current) return;
		const selected = listRef.current.children[selectedIndex] as
			| HTMLElement
			| undefined;
		selected?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter" && filtered[selectedIndex]) {
				e.preventDefault();
				// A disabled entry keeps the palette open rather than closing on a
				// no-op, so the reason in its label stays on screen.
				if (filtered[selectedIndex].disabled) return;
				filtered[selectedIndex].action();
				onClose();
			} else if (e.key === "Escape") {
				onClose();
			}
		},
		[filtered, selectedIndex, onClose],
	);

	if (!isOpen) return null;

	// Group by category for display
	let lastCategory = "";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-start justify-center"
			style={{ paddingTop: 80, backgroundColor: "rgba(0,0,0,0.5)" }}
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			<div
				role="dialog"
				className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
				style={{
					width: 520,
					maxHeight: 420,
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				<div
					className="p-3"
					style={{ borderBottom: "1px solid var(--border)" }}
				>
					<input
						ref={inputRef}
						type="text"
						placeholder="Search commands, workspaces, agents..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="w-full bg-transparent outline-none"
						style={{
							color: "var(--fg-primary)",
							fontSize: 15,
							padding: "6px 4px",
						}}
					/>
				</div>
				<div ref={listRef} className="flex-1 overflow-y-auto py-2">
					{filtered.length === 0 && (
						<div
							className="px-4 py-6 text-center"
							style={{ color: "var(--fg-secondary)", fontSize: 14 }}
						>
							No results
						</div>
					)}
					{filtered.map((item, i) => {
						const showCategory = item.category !== lastCategory;
						lastCategory = item.category;
						return (
							<div key={item.id}>
								{showCategory && (
									<div
										className="px-4 pt-3 pb-1 font-semibold"
										style={{
											fontSize: 11,
											color: "var(--fg-secondary)",
											letterSpacing: "0.05em",
											textTransform: "uppercase",
										}}
									>
										{item.category}
									</div>
								)}
								<button
									type="button"
									disabled={item.disabled}
									onClick={() => {
										if (item.disabled) return;
										item.action();
										onClose();
									}}
									onMouseEnter={() => setSelectedIndex(i)}
									className="w-full text-left flex items-center rounded-lg mx-1.5 transition-colors"
									style={{
										padding: "8px 12px",
										fontSize: 14,
										width: "calc(100% - 12px)",
										opacity: item.disabled ? 0.45 : 1,
										cursor: item.disabled ? "not-allowed" : "pointer",
										color:
											i === selectedIndex
												? "var(--bg-primary)"
												: "var(--fg-primary)",
										backgroundColor:
											i === selectedIndex ? "var(--accent)" : "transparent",
									}}
								>
									{item.label}
								</button>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
