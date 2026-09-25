import { FolderOpen, Layers } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirmUnloadWorkspace } from "../../hooks/useConfirmUnloadWorkspace";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { hasFleetAgents, rememberedAgents } from "../../lib/dormantWorkspaces";
import type { WorkspaceWithTabs } from "../../lib/types";
import {
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Open and unload Workspaces from the **Fleet Console**. Opening one adds its
 * Agents to the Console; unloading one removes them. See CONTEXT.md.
 *
 * Opening happens in the background — the Workspace is Opened, not made
 * Active — so the Workspace view behind the Console is left alone. Its
 * remembered Agents are shown as tiles straight away (`expectFleetTiles`):
 * a remembered Agent relaunches only once its terminal is drawn, and a
 * Workspace nobody has looked at has no Tab on screen to draw it in.
 *
 * Unloading is the Left sidebar's **Unload Workspace**, with the same
 * confirmation when an Agent is Working or a command is running.
 */
export function WorkspacePicker({
	agentCountByWorkspace,
}: {
	/** How many tiles each Workspace has in the Console now. */
	agentCountByWorkspace: ReadonlyMap<string, number>;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const allWorkspaces = useWorkspaceStore((s) => s.workspaces);
	const agents = useSettingsStore((s) => s.agents);
	// Only Workspaces with Agents to show: one without adds nothing here.
	const workspaces = useMemo(() => {
		const known = new Set(agents.map((a) => a.id));
		return allWorkspaces.filter((w) =>
			hasFleetAgents(w, known, agentCountByWorkspace.get(w.id) ?? 0),
		);
	}, [allWorkspaces, agents, agentCountByWorkspace]);
	const openedIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const { requestUnload, dialogProps } = useConfirmUnloadWorkspace();

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (rootRef.current?.contains(t)) return;
			// The unload confirmation is portaled to <body>; clicking it must
			// not also close this list underneath.
			if ((t as Element).closest?.('[role="dialog"]')) return;
			setOpen(false);
		};
		document.addEventListener("mousedown", onDown, true);
		return () => document.removeEventListener("mousedown", onDown, true);
	}, [open]);

	const openedCount = workspaces.filter((w) => openedIds.has(w.id)).length;

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="Open or unload workspaces — their agents join or leave the console"
				className="flex items-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
				style={{
					height: 24,
					padding: "0 8px",
					gap: 6,
					borderRadius: 5,
					border: "1px solid var(--border)",
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					cursor: "pointer",
					transition: "background 120ms ease, color 120ms ease",
				}}
			>
				<Layers size={12} />
				{openedCount}/{workspaces.length} open
			</button>
			{open && (
				<WorkspaceList
					workspaces={workspaces}
					allWorkspaces={allWorkspaces}
					openedIds={openedIds}
					agentCountByWorkspace={agentCountByWorkspace}
					onOpen={openInBackground}
					onUnload={requestUnload}
					onClose={() => setOpen(false)}
				/>
			)}
			{dialogProps && <ConfirmDialog {...dialogProps} />}
		</div>
	);
}

/** Open a Workspace without making it Active, and show its remembered Agents
 *  as tiles so they get drawn — and therefore relaunched. Exported for tests. */
export function openInBackground(workspaceId: string): void {
	const ws = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === workspaceId);
	if (!ws) return;
	const activity = usePtyActivityStore.getState();
	if (activity.openedWorkspaceIds.has(workspaceId)) return;
	activity.markWorkspaceOpened(workspaceId);
	useWindowUiStore.getState().expectFleetTiles(rememberedAgentPanes(ws));
}

/** Pane ids of every terminal in the Workspace that remembers an Agent. */
export function rememberedAgentPanes(ws: WorkspaceWithTabs): string[] {
	return rememberedAgents(ws).map((a) => a.paneId);
}

function WorkspaceList({
	workspaces,
	allWorkspaces,
	openedIds,
	agentCountByWorkspace,
	onOpen,
	onUnload,
	onClose,
}: {
	workspaces: WorkspaceWithTabs[];
	/** Every Workspace, so Worktree sets group as in the Left sidebar even when
	 *  some members are not listed. */
	allWorkspaces: WorkspaceWithTabs[];
	openedIds: ReadonlySet<string>;
	agentCountByWorkspace: ReadonlyMap<string, number>;
	onOpen: (id: string) => void;
	onUnload: (id: string) => void;
	onClose: () => void;
}) {
	useEscapeKey(onClose);
	const facts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const gitById = useWorkspaceGitStore((s) => s.byWorkspaceId);
	const [query, setQuery] = useState("");

	const ordered = useMemo(() => {
		const byId = new Map(workspaces.map((w) => [w.id, w]));
		const list = flattenRowsToIds(buildWorkspaceRows(allWorkspaces, facts))
			.map((id) => byId.get(id))
			.filter((w): w is WorkspaceWithTabs => !!w);
		const q = query.trim().toLowerCase();
		return q
			? list.filter(
					(w) =>
						w.name.toLowerCase().includes(q) ||
						w.rootFolder.toLowerCase().includes(q),
				)
			: list;
	}, [workspaces, allWorkspaces, facts, query]);

	return (
		<div
			className="absolute right-0 z-50 flex flex-col select-none"
			style={{
				top: "calc(100% + 6px)",
				width: 380,
				maxHeight: "min(520px, 70vh)",
				borderRadius: 8,
				border: "1px solid var(--border)",
				background: "var(--bg-secondary)",
				boxShadow: "0 12px 32px rgb(0 0 0 / 0.35)",
			}}
		>
			<div style={{ padding: 8 }}>
				<input
					// biome-ignore lint/a11y/noAutofocus: the list opens to be searched
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => e.stopPropagation()}
					placeholder="Filter workspaces"
					spellCheck={false}
					style={{
						width: "100%",
						height: 28,
						padding: "0 10px",
						fontSize: 12,
						borderRadius: 6,
						color: "var(--fg-primary)",
						backgroundColor: "var(--bg-primary)",
						border: "1px solid var(--border)",
						outline: "none",
					}}
				/>
			</div>
			<div className="overflow-y-auto" style={{ padding: "0 6px 6px" }}>
				{ordered.length === 0 && (
					<div
						style={{
							padding: "10px 8px",
							fontSize: 12,
							color: "var(--fg-secondary)",
						}}
					>
						{query.trim()
							? "No workspace matches."
							: "No workspace has agents to show."}
					</div>
				)}
				{ordered.map((w) => {
					const isOpen = openedIds.has(w.id);
					const agents = agentCountByWorkspace.get(w.id) ?? 0;
					const branch = gitById[w.id]?.currentBranch ?? w.lastBranch;
					return (
						<div
							key={w.id}
							className="flex items-center hover:bg-[var(--bg-tertiary)]"
							style={{ padding: "6px 8px", gap: 10, borderRadius: 6 }}
						>
							<div className="flex flex-col min-w-0 flex-1" style={{ gap: 1 }}>
								<span
									className="truncate"
									style={{
										fontSize: 12.5,
										color: isOpen ? "var(--fg-primary)" : "var(--fg-secondary)",
										fontWeight: isOpen ? 600 : 400,
									}}
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
									{isOpen &&
										` · ${agents === 0 ? "no agents" : `${agents} agent${agents === 1 ? "" : "s"}`}`}
								</span>
							</div>
							<button
								type="button"
								onClick={() => (isOpen ? onUnload(w.id) : onOpen(w.id))}
								aria-label={isOpen ? `Unload ${w.name}` : `Open ${w.name}`}
								className={`flex items-center shrink-0 ${
									isOpen
										? "text-[var(--fg-secondary)] hover:text-[var(--error)]"
										: "text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
								}`}
								style={{
									height: 24,
									padding: "0 9px",
									gap: 5,
									borderRadius: 5,
									fontSize: 11.5,
									cursor: "pointer",
									border: `1px solid ${
										isOpen
											? "var(--border)"
											: "color-mix(in srgb, var(--accent) 45%, transparent)"
									}`,
								}}
							>
								{isOpen ? (
									"Unload"
								) : (
									<>
										<FolderOpen size={12} />
										Open
									</>
								)}
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
