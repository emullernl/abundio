import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, GitBranch } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { collectTerminalIds, parseTabLayout } from "../../lib/paneTree";
import type { Tab } from "../../lib/types";
import {
	addWorktreeTargetId,
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../PromptActions/fieldStyles";

/**
 * **New agent** from the Fleet Console: pick a Workspace (any in the Active
 * profile, Opened first) and an Agent. The Agent starts in a new Tab that does
 * not become active, so the Workspace view is left as it was. For a git
 * Workspace, *Create a new worktree* hands off to the Add worktree dialog with
 * the Agent pre-selected, and the new Workspace opens in the background.
 */
export function NewAgentDialog({ onClose }: { onClose: () => void }) {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const facts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const opened = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const agents = useSettingsStore((s) => s.agents);
	const enabledAgents = useMemo(
		() => agents.filter((a) => a.enabled),
		[agents],
	);

	const ordered = useMemo(() => {
		const order = flattenRowsToIds(buildWorkspaceRows(workspaces, facts));
		const byId = new Map(workspaces.map((w) => [w.id, w]));
		const list = order.map((id) => byId.get(id)).filter((w) => !!w);
		const openFirst = [
			...list.filter((w) => opened.has(w.id)),
			...list.filter((w) => !opened.has(w.id)),
		];
		return openFirst;
	}, [workspaces, facts, opened]);

	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return ordered;
		return ordered.filter(
			(w) =>
				w.name.toLowerCase().includes(q) ||
				w.rootFolder.toLowerCase().includes(q),
		);
	}, [ordered, query]);

	const [wsIndex, setWsIndex] = useState(0);
	const [agentIndex, setAgentIndex] = useState(0);
	const [worktree, setWorktree] = useState(false);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const selectedWs = filtered[Math.min(wsIndex, filtered.length - 1)];
	const agent = enabledAgents[agentIndex];
	const worktreeTarget = selectedWs
		? addWorktreeTargetId(workspaces, facts, selectedWs.id)
		: null;
	const canWorktree = worktreeTarget !== null;
	const useWorktree = worktree && canWorktree;
	const canSubmit = !!selectedWs && !!agent && !starting;

	useEscapeKey(onClose);

	const moveWs = (step: number) => {
		if (filtered.length === 0) return;
		const next = Math.max(0, Math.min(filtered.length - 1, wsIndex + step));
		setWsIndex(next);
		listRef.current
			?.querySelector(`[data-index="${next}"]`)
			?.scrollIntoView({ block: "nearest" });
	};

	const submit = async (target = selectedWs) => {
		if (!target || !agent) return;
		const selectedWs = target;
		const worktreeTarget = addWorktreeTargetId(
			workspaces,
			facts,
			selectedWs.id,
		);
		const useWorktree = worktree && worktreeTarget !== null;
		if (useWorktree && worktreeTarget) {
			useWindowUiStore.getState().requestAddWorktree(worktreeTarget, {
				agentId: agent.id,
				background: true,
			});
			onClose();
			return;
		}
		// Create the Tab first and only then open the Workspace and close the
		// dialog: a failed create must not leave the Workspace opened with no
		// Agent in it, nor vanish without a word.
		setStarting(true);
		setError(null);
		let tab: Tab;
		try {
			tab = await useWorkspaceStore
				.getState()
				.createTab(selectedWs.id, agent, undefined, { activate: false });
		} catch (e) {
			setStarting(false);
			setError(
				`Could not start ${agent.name} in ${selectedWs.name}: ${
					e instanceof Error ? e.message : String(e)
				}`,
			);
			return;
		}
		const activity = usePtyActivityStore.getState();
		if (!activity.openedWorkspaceIds.has(selectedWs.id)) {
			activity.markWorkspaceOpened(selectedWs.id);
		}
		const layout = parseTabLayout(tab.layoutJson);
		const paneId = layout ? collectTerminalIds(layout)[0] : undefined;
		if (paneId) useWindowUiStore.getState().expectFleetTile(paneId);
		onClose();
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			moveWs(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveWs(-1);
		} else if (e.key === "ArrowRight" && e.altKey) {
			e.preventDefault();
			setAgentIndex((i) => Math.min(enabledAgents.length - 1, i + 1));
		} else if (e.key === "ArrowLeft" && e.altKey) {
			e.preventDefault();
			setAgentIndex((i) => Math.max(0, i - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (canSubmit) void submit();
		}
	};

	const openedCount = filtered.filter((w) => opened.has(w.id)).length;

	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[200] flex items-center justify-center"
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				exit={{ opacity: 0 }}
				transition={{ duration: 0.15 }}
				style={{
					backgroundColor: "rgba(0,0,0,0.55)",
					backdropFilter: "blur(6px)",
					WebkitBackdropFilter: "blur(6px)",
				}}
				onClick={onClose}
			>
				<motion.div
					role="dialog"
					aria-label="New agent"
					className="rounded-2xl overflow-hidden flex flex-col outline-none"
					initial={{ opacity: 0, scale: 0.96, y: 12 }}
					animate={{ opacity: 1, scale: 1, y: 0 }}
					exit={{ opacity: 0, scale: 0.96, y: 12 }}
					transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
					style={{
						width: 560,
						maxHeight: "min(640px, 86vh)",
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 40px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04) inset",
					}}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						// Keep keystrokes away from the terminal underneath.
						e.stopPropagation();
						onKeyDown(e);
					}}
				>
					<div className="flex flex-col" style={{ padding: "24px 28px 14px" }}>
						<span
							style={{
								color: "var(--accent)",
								fontSize: 10,
								fontWeight: 600,
								letterSpacing: "0.14em",
								textTransform: "uppercase",
								marginBottom: 8,
							}}
						>
							New agent
						</span>
						<input
							// biome-ignore lint/a11y/noAutofocus: the dialog's first job is picking a workspace
							autoFocus
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setWsIndex(0);
							}}
							placeholder="Which workspace?"
							spellCheck={false}
							style={{
								height: 36,
								padding: "0 12px",
								fontSize: 14,
								borderRadius: 8,
								color: "var(--fg-primary)",
								backgroundColor: "var(--bg-primary)",
								border: "1px solid var(--border)",
								outline: "none",
							}}
						/>
					</div>

					<div
						ref={listRef}
						className="flex-1 min-h-0 overflow-y-auto"
						style={{ padding: "0 20px", minHeight: 120 }}
					>
						{filtered.length === 0 && (
							<div
								style={{
									padding: "18px 8px",
									fontSize: 12,
									color: "var(--fg-secondary)",
								}}
							>
								No workspace matches.
							</div>
						)}
						{filtered.map((w, i) => {
							const isOpen = opened.has(w.id);
							const heading =
								i === 0 && isOpen
									? "Opened"
									: i === openedCount
										? "Not opened — opens in the background"
										: null;
							const selected = w.id === selectedWs?.id;
							return (
								<div key={w.id}>
									{heading && (
										<div
											style={{
												padding: "10px 8px 4px",
												fontSize: 10,
												fontWeight: 600,
												letterSpacing: "0.1em",
												textTransform: "uppercase",
												color: "var(--fg-secondary)",
												opacity: 0.7,
											}}
										>
											{heading}
										</div>
									)}
									<button
										type="button"
										data-index={i}
										onClick={() => setWsIndex(i)}
										onDoubleClick={() => {
											setWsIndex(i);
											void submit(w);
										}}
										className={`w-full flex items-center text-left ${
											selected ? "" : "hover:bg-[var(--bg-tertiary)]"
										}`}
										style={{
											padding: "7px 10px",
											gap: 10,
											borderRadius: 7,
											cursor: "pointer",
											background: selected
												? "color-mix(in srgb, var(--accent) 16%, transparent)"
												: undefined,
											boxShadow: selected
												? "inset 2px 0 0 var(--accent)"
												: undefined,
										}}
									>
										<span
											className="truncate"
											style={{
												fontSize: 13,
												color: "var(--fg-primary)",
												fontWeight: selected ? 600 : 400,
											}}
										>
											{w.name}
										</span>
										<span
											className="truncate"
											style={{
												flex: 1,
												minWidth: 0,
												fontFamily: "var(--font-mono)",
												fontSize: 11,
												color: "var(--fg-secondary)",
												opacity: 0.7,
												textAlign: "right",
											}}
										>
											{w.rootFolder}
										</span>
									</button>
								</div>
							);
						})}
					</div>

					<div
						className="flex flex-col"
						style={{
							padding: "14px 28px 0",
							gap: 10,
							borderTop: "1px solid var(--border)",
							marginTop: 10,
						}}
					>
						<div className="flex flex-wrap" style={{ gap: 6 }}>
							{enabledAgents.length === 0 && (
								<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
									No agents are switched on. Turn one on in Settings ▸ Agents.
								</span>
							)}
							{enabledAgents.map((a, i) => {
								const Icon = getAgentIconComponent(a.id);
								const selected = i === agentIndex;
								return (
									<button
										key={a.id}
										type="button"
										onClick={() => setAgentIndex(i)}
										aria-pressed={selected}
										className={`flex items-center ${
											selected
												? "text-[var(--fg-primary)]"
												: "text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
										}`}
										style={{
											height: 28,
											padding: "0 10px 0 8px",
											gap: 6,
											borderRadius: 999,
											fontSize: 12,
											cursor: "pointer",
											border: `1px solid ${
												selected ? "var(--accent)" : "var(--border)"
											}`,
											background: selected
												? "color-mix(in srgb, var(--accent) 14%, transparent)"
												: undefined,
										}}
									>
										{Icon ? (
											<Icon size={14} />
										) : (
											<FallbackAgentIcon size={13} />
										)}
										{a.name}
									</button>
								);
							})}
						</div>
						<label
							className="flex items-center select-none"
							title={
								canWorktree
									? undefined
									: "Only a git workspace can have worktrees."
							}
							style={{
								gap: 8,
								fontSize: 12,
								color: canWorktree
									? "var(--fg-primary)"
									: "var(--fg-secondary)",
								opacity: canWorktree ? 1 : 0.55,
								cursor: canWorktree ? "pointer" : "default",
							}}
						>
							<input
								type="checkbox"
								checked={useWorktree}
								disabled={!canWorktree}
								onChange={(e) => setWorktree(e.target.checked)}
								style={{ accentColor: "var(--accent)" }}
							/>
							<GitBranch size={13} />
							Create a new worktree
							{canWorktree &&
								worktreeTarget !== selectedWs?.id &&
								` of ${workspaces.find((w) => w.id === worktreeTarget)?.name ?? ""}`}
						</label>
					</div>

					<div
						className="flex items-center justify-between"
						style={{ padding: "16px 28px 20px" }}
					>
						{error ? (
							<span
								role="alert"
								style={{
									fontSize: 11.5,
									color: "var(--error)",
									maxWidth: 300,
								}}
							>
								{error}
							</span>
						) : (
							<span
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									opacity: 0.7,
								}}
							>
								↑↓ workspace · ⌥←→ agent
							</span>
						)}
						<div className="flex" style={{ gap: 8 }}>
							<button
								type="button"
								onClick={onClose}
								className={secondaryButtonClass}
								style={{ height: 32, padding: "0 14px", borderRadius: 6 }}
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								onClick={() => void submit()}
								className={`flex items-center ${primaryButtonClass}`}
								style={{
									height: 32,
									padding: "0 14px",
									gap: 6,
									borderRadius: 6,
								}}
							>
								{useWorktree ? "Choose branch…" : "Start agent"}
								<CornerDownLeft size={12} />
							</button>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}
