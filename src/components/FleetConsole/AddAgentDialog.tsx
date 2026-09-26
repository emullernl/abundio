import { AnimatePresence, motion } from "framer-motion";
import { ListPlus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import {
	type AgentCount,
	buildRelaunchRows,
	type RelaunchRow,
} from "../../lib/dormantWorkspaces";
import { openNewTask } from "../../lib/openNewTask";
import type { CodingAgent } from "../../lib/types";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { BackButton, NewAgentDialog } from "./NewAgentDialog";
import { openInBackground } from "./WorkspacePicker";

export type AddAgentStep = "choose" | "new" | "relaunch";

/** The Relaunch rows for this Window, kept live as Workspaces open. Computed
 *  once by the Console and handed to the dialog, since it parses every Tab. */
export function useRelaunchRows(): RelaunchRow[] {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const facts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const opened = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const agents = useSettingsStore((s) => s.agents);
	return useMemo(
		() =>
			buildRelaunchRows(
				workspaces,
				facts,
				opened,
				new Set(agents.map((a) => a.id)),
			),
		[workspaces, facts, opened, agents],
	);
}

type WorkspaceRow = Extract<RelaunchRow, { kind: "workspace" }>;

export function relaunchTargets(rows: RelaunchRow[]): WorkspaceRow[] {
	return rows.filter((r): r is WorkspaceRow => r.kind === "workspace");
}

/**
 * **Add agent** in the Fleet Console: choose between **New agent**, **New
 * task** and **Relaunch** of a Dormant workspace. Relaunch is offered only
 * when something is Dormant. See CONTEXT.md.
 */
export function AddAgentDialog({
	rows,
	initialStep = "choose",
	onClose,
	onReopen,
}: {
	/** From `useRelaunchRows`. */
	rows: RelaunchRow[];
	initialStep?: Exclude<AddAgentStep, "new">;
	onClose: () => void;
	/** Reopen this dialog on its chooser — New task's Back. */
	onReopen: () => void;
}) {
	const dormant = relaunchTargets(rows);
	const [step, setStep] = useState<AddAgentStep>(initialStep);
	// Only the first step animates in; later swaps keep the backdrop still.
	const [swapped, setSwapped] = useState(false);
	const go = (next: AddAgentStep) => {
		setSwapped(true);
		setStep(next);
	};

	// Nothing Dormant: there is no choice to make. Decided once, on opening —
	// a Workspace opening elsewhere must not turn this into another dialog
	// under the user's hands.
	const shown: AddAgentStep = step;

	if (shown === "new") {
		return (
			<NewAgentDialog
				onClose={onClose}
				onBack={() => go("choose")}
				animateIn={!swapped}
			/>
		);
	}
	return (
		<Shell animateIn={!swapped} onClose={onClose}>
			{shown === "choose" ? (
				<Chooser
					dormant={dormant}
					onNew={() => go("new")}
					onTask={() => {
						// The New task dialog is app-level; Back reopens this chooser.
						onClose();
						openNewTask({ onBack: onReopen });
					}}
					onRelaunch={() => go("relaunch")}
				/>
			) : (
				<RelaunchList
					rows={rows}
					onBack={() => go("choose")}
					onRelaunch={(id) => {
						openInBackground(id);
						onClose();
					}}
				/>
			)}
		</Shell>
	);
}

function Shell({
	animateIn,
	onClose,
	children,
}: {
	animateIn: boolean;
	onClose: () => void;
	children: React.ReactNode;
}) {
	useEscapeKey(onClose);
	return (
		<AnimatePresence>
			<motion.div
				role="presentation"
				className="fixed inset-0 z-[200] flex items-center justify-center"
				initial={animateIn ? { opacity: 0 } : false}
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
					aria-label="Add agent"
					className="rounded-2xl overflow-hidden flex flex-col outline-none"
					initial={animateIn ? { opacity: 0, scale: 0.96, y: 12 } : false}
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
					// Keep keystrokes away from the terminal underneath.
					onKeyDown={(e) => e.stopPropagation()}
				>
					{children}
				</motion.div>
			</motion.div>
		</AnimatePresence>
	);
}

function Eyebrow({ children }: { children: React.ReactNode }) {
	return (
		<span
			style={{
				color: "var(--accent)",
				fontSize: 10,
				fontWeight: 600,
				letterSpacing: "0.14em",
				textTransform: "uppercase",
			}}
		>
			{children}
		</span>
	);
}

/** Arrow keys move the selection, Enter acts on it. Focuses its root on mount
 *  so the keys work without a click. */
function useListKeys(count: number, onEnter: (i: number) => void) {
	const idPrefix = useId();
	const [index, setIndex] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => rootRef.current?.focus(), []);
	const clamped = Math.min(index, Math.max(0, count - 1));
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setIndex(Math.max(0, Math.min(count - 1, clamped + step)));
		} else if (e.key === "Enter" && count > 0) {
			e.preventDefault();
			onEnter(clamped);
		}
	};
	const optionId = (i: number) => `${idPrefix}-opt-${i}`;
	return {
		index: clamped,
		setIndex,
		rootRef,
		onKeyDown,
		optionId,
		// Focus stays on the listbox; this tells a screen reader which option
		// the arrows are on.
		activeId: count > 0 ? optionId(clamped) : undefined,
	};
}

function Chooser({
	dormant,
	onNew,
	onTask,
	onRelaunch,
}: {
	dormant: WorkspaceRow[];
	onNew: () => void;
	onTask: () => void;
	onRelaunch: () => void;
}) {
	const agents = useSettingsStore((s) => s.agents);
	const hasDormant = dormant.length > 0;
	const actions = hasDormant ? [onNew, onTask, onRelaunch] : [onNew, onTask];
	const keys = useListKeys(actions.length, (i) => actions[i]());
	const preview = dormant.slice(0, 3);

	return (
		<div
			className="flex flex-col"
			style={{ padding: "24px 20px 20px", gap: 6 }}
		>
			<div style={{ padding: "0 8px 8px" }}>
				<Eyebrow>Add agent</Eyebrow>
			</div>
			<div
				ref={keys.rootRef}
				role="listbox"
				aria-label="Add agent"
				aria-activedescendant={keys.activeId}
				tabIndex={-1}
				onKeyDown={keys.onKeyDown}
				className="flex flex-col outline-none"
				style={{ gap: 6 }}
			>
				<Option
					id={keys.optionId(0)}
					selected={keys.index === 0}
					onHover={() => keys.setIndex(0)}
					onClick={onNew}
					icon={<Plus size={16} />}
					title="New agent"
					subtitle="Start a fresh agent in any workspace."
				/>
				<Option
					id={keys.optionId(1)}
					selected={keys.index === 1}
					onHover={() => keys.setIndex(1)}
					onClick={onTask}
					icon={<ListPlus size={16} />}
					title="New task"
					subtitle="Start an agent on a task you describe or a GitHub issue."
				/>
				{hasDormant && (
					<Option
						id={keys.optionId(2)}
						selected={keys.index === 2}
						onHover={() => keys.setIndex(2)}
						onClick={onRelaunch}
						icon={<RotateCcw size={15} />}
						title="Relaunch from a dormant workspace"
						badge={dormant.length}
						subtitle="Opens it and starts again the agents it had. Each starts a fresh session."
					>
						<div className="flex flex-col" style={{ gap: 3, marginTop: 8 }}>
							{preview.map((r) => (
								<div
									key={r.workspace.id}
									className="flex items-center min-w-0"
									style={{ gap: 8, fontSize: 12 }}
								>
									<span
										className="truncate"
										style={{ color: "var(--fg-primary)", maxWidth: 200 }}
									>
										{r.workspace.name}
									</span>
									<AgentChips counts={r.agents} agents={agents} />
								</div>
							))}
							{dormant.length > preview.length && (
								<span
									style={{
										fontSize: 11.5,
										color: "var(--fg-secondary)",
										opacity: 0.8,
									}}
								>
									and {dormant.length - preview.length} more
								</span>
							)}
						</div>
					</Option>
				)}
			</div>
			<span
				style={{
					padding: "8px 8px 0",
					fontSize: 11,
					color: "var(--fg-secondary)",
					opacity: 0.7,
				}}
			>
				↑↓ choose · ↵ continue
			</span>
		</div>
	);
}

function Option({
	id,
	selected,
	onHover,
	onClick,
	icon,
	title,
	subtitle,
	badge,
	children,
}: {
	id: string;
	selected: boolean;
	onHover: () => void;
	onClick: () => void;
	icon: React.ReactNode;
	title: string;
	subtitle: string;
	badge?: number;
	children?: React.ReactNode;
}) {
	return (
		<button
			id={id}
			type="button"
			role="option"
			aria-selected={selected}
			onClick={onClick}
			onMouseEnter={onHover}
			className="w-full flex text-left"
			style={{
				padding: "12px 14px",
				gap: 12,
				borderRadius: 10,
				cursor: "pointer",
				border: `1px solid ${
					selected
						? "color-mix(in srgb, var(--accent) 55%, transparent)"
						: "var(--border)"
				}`,
				background: selected
					? "color-mix(in srgb, var(--accent) 10%, transparent)"
					: "transparent",
				transition: "background 120ms ease, border-color 120ms ease",
			}}
		>
			<span
				className="flex items-center justify-center shrink-0"
				style={{
					width: 30,
					height: 30,
					borderRadius: 999,
					border: "1px solid currentColor",
					color: selected ? "var(--accent)" : "var(--fg-secondary)",
				}}
			>
				{icon}
			</span>
			<span className="flex flex-col min-w-0 flex-1" style={{ gap: 2 }}>
				<span
					className="flex items-center"
					style={{
						gap: 8,
						fontSize: 13.5,
						fontWeight: 600,
						color: "var(--fg-primary)",
					}}
				>
					{title}
					{badge !== undefined && (
						<span
							style={{
								padding: "0 6px",
								borderRadius: 999,
								fontSize: 11,
								fontWeight: 600,
								color: "var(--accent)",
								background:
									"color-mix(in srgb, var(--accent) 16%, transparent)",
							}}
						>
							{badge}
						</span>
					)}
				</span>
				<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
					{subtitle}
				</span>
				{children}
			</span>
		</button>
	);
}

function AgentChips({
	counts,
	agents,
}: {
	counts: AgentCount[];
	agents: CodingAgent[];
}) {
	return (
		<span
			className="flex items-center min-w-0"
			style={{ gap: 8, fontSize: 11.5, color: "var(--fg-secondary)" }}
		>
			{counts.map(({ agentId, count }) => {
				const Icon = getAgentIconComponent(agentId);
				const name = agents.find((a) => a.id === agentId)?.name ?? agentId;
				return (
					<span
						key={agentId}
						className="flex items-center shrink-0"
						style={{ gap: 4 }}
					>
						{Icon ? <Icon size={12} /> : <FallbackAgentIcon size={11} />}
						{name}
						{count > 1 && ` ×${count}`}
					</span>
				);
			})}
		</span>
	);
}

function RelaunchList({
	rows,
	onBack,
	onRelaunch,
}: {
	rows: RelaunchRow[];
	onBack: () => void;
	/** Relaunch one Workspace; the dialog closes. */
	onRelaunch: (workspaceId: string) => void;
}) {
	const agents = useSettingsStore((s) => s.agents);
	const gitById = useWorkspaceGitStore((s) => s.byWorkspaceId);
	const targets = relaunchTargets(rows);
	const indexOf = new Map(targets.map((r, i) => [r, i]));
	const keys = useListKeys(targets.length, (i) =>
		onRelaunch(targets[i].workspace.id),
	);
	useEffect(() => {
		keys.rootRef.current
			?.querySelector(`[data-index="${keys.index}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [keys.index, keys.rootRef]);

	return (
		<div className="flex flex-col min-h-0">
			<div className="flex flex-col" style={{ padding: "24px 28px 12px" }}>
				<div className="flex items-center" style={{ gap: 8 }}>
					<BackButton onClick={onBack} />
					<Eyebrow>Relaunch from a dormant workspace</Eyebrow>
				</div>
				<span
					style={{
						marginTop: 8,
						fontSize: 12,
						color: "var(--fg-secondary)",
					}}
				>
					Opens the workspace in the background and starts its agents again in
					the panes they had. Each starts a fresh session.
				</span>
			</div>
			<div
				ref={keys.rootRef}
				role="listbox"
				aria-label="Dormant workspaces"
				aria-activedescendant={keys.activeId}
				tabIndex={-1}
				onKeyDown={keys.onKeyDown}
				className="flex-1 min-h-0 overflow-y-auto outline-none"
				style={{ padding: "0 20px 8px" }}
			>
				{rows.map((r) => {
					if (r.kind === "heading") {
						return (
							<div
								key={`h-${r.workspace.id}`}
								role="presentation"
								className="truncate"
								style={{
									padding: "10px 10px 4px",
									fontSize: 11.5,
									color: "var(--fg-secondary)",
								}}
							>
								{r.workspace.name}
								{r.opened && <span style={{ opacity: 0.6 }}> · open</span>}
							</div>
						);
					}
					const i = indexOf.get(r) ?? -1;
					const selected = i === keys.index;
					const w = r.workspace;
					const branch = gitById[w.id]?.currentBranch ?? w.lastBranch;
					return (
						<button
							key={w.id}
							id={keys.optionId(i)}
							type="button"
							role="option"
							aria-selected={selected}
							data-index={i}
							onClick={() => onRelaunch(w.id)}
							onMouseEnter={() => keys.setIndex(i)}
							className="w-full flex items-center text-left"
							style={{
								padding: "8px 10px",
								paddingLeft: r.indent ? 28 : 10,
								gap: 12,
								borderRadius: 7,
								cursor: "pointer",
								background: selected
									? "color-mix(in srgb, var(--accent) 14%, transparent)"
									: undefined,
								boxShadow: selected ? "inset 2px 0 0 var(--accent)" : undefined,
							}}
						>
							<span className="flex flex-col min-w-0 flex-1" style={{ gap: 3 }}>
								<span
									className="flex items-baseline min-w-0"
									style={{ gap: 8 }}
								>
									<span
										className="truncate"
										style={{ fontSize: 13, color: "var(--fg-primary)" }}
									>
										{w.name}
									</span>
									<span
										className="truncate"
										style={{
											fontFamily: "var(--font-mono)",
											fontSize: 10.5,
											color: "var(--fg-secondary)",
											opacity: 0.7,
										}}
									>
										{branch ?? w.rootFolder}
									</span>
								</span>
								<AgentChips counts={r.agents} agents={agents} />
							</span>
							<span
								className="flex items-center shrink-0"
								style={{
									gap: 5,
									fontSize: 11.5,
									color: selected ? "var(--accent)" : "var(--fg-secondary)",
								}}
							>
								<RotateCcw size={12} />
								Relaunch
							</span>
						</button>
					);
				})}
			</div>
			<span
				style={{
					padding: "8px 28px 18px",
					fontSize: 11,
					color: "var(--fg-secondary)",
					opacity: 0.7,
				}}
			>
				↑↓ workspace · ↵ relaunch · Esc close
			</span>
		</div>
	);
}
