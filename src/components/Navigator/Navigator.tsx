import {
	AppWindow,
	ChevronDown,
	ChevronRight,
	Eye,
	FileText,
	Folder,
	GitBranch,
	Search,
	SquareTerminal,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import {
	useTabRollups,
	useWorkspaceRollups,
} from "../../hooks/useWorkspaceRollups";
import { FallbackAgentIcon, getAgentIconComponent } from "../../lib/agentIcons";
import { raiseFileWindows } from "../../lib/fileWindowRaise";
import { targetPaneId } from "../../lib/fleetFocus";
import { fileWindows, type OpenFileWindow } from "../../lib/ipc";
import {
	initialSelection,
	isFolder,
	NAV_STATUSES,
	type NavRow,
	type NavScope,
	type NavStatus,
	navigatorRows,
	navigatorWorkspaceOrder,
	parentKey,
} from "../../lib/navigatorTree";
import { revealPane, switchToPane } from "../../lib/paneLocation";
import { getTerminal } from "../../lib/terminalManager";
import type { Tab, WorkspaceWithTabs } from "../../lib/types";
import { buildWorkspaceRows } from "../../lib/worktreeGrouping";
import {
	computePtyDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { AgentStatusIcon } from "../AgentStatusIcon";
import { StatusComposite } from "../StatusComposite";

const STATUS_CHIPS: Record<NavStatus, { label: string; icon: DotStatus }> = {
	waiting: { label: "Waiting", icon: "skyblue" },
	working: { label: "Working", icon: "amber" },
	ready: { label: "Ready", icon: "purple" },
	idle: { label: "Idle", icon: "green" },
	error: { label: "Error", icon: "red" },
};

const INDENT = 16;
const NO_STATUSES: ReadonlySet<NavStatus> = new Set();

/** Go to a row's place in the Workspace view. Always leaves the Fleet
 *  Console, as **Switch to** does. */
function goTo(row: NavRow): void {
	if (row.kind === "pane") {
		switchToPane(row.paneId);
		return;
	}
	useWindowUiStore.getState().setFleetConsoleOpen(false);
	if (row.kind === "window") {
		// Its Workspace becomes Active, which raises all its File windows
		// without focus; focus the picked one once that raise is done, so it
		// ends up on top.
		const { workspaceId, windowLabel } = row;
		useWorkspaceStore.getState().beginWorkspaceSwitch(workspaceId);
		void raiseFileWindows(workspaceId).then(() =>
			fileWindows.focus(windowLabel).catch(() => {}),
		);
		return;
	}
	if (row.kind === "tab") {
		revealPane(null, row.workspaceId, row.tabId);
	} else {
		useWorkspaceStore.getState().beginWorkspaceSwitch(row.workspaceId);
	}
}

/** Give keyboard focus back to the target terminal once the dialog is gone,
 *  unless something else has already taken it. */
function restoreTerminalFocus(): void {
	requestAnimationFrame(() => {
		const active = document.activeElement;
		if (active && active !== document.body) return;
		const id = targetPaneId();
		if (id) getTerminal(id)?.term.focus();
	});
}

/**
 * The **Navigator**: Workspace › Tab › Pane for this Window, with search, a
 * scope toggle and an Agent status filter. Always opens fresh.
 */
export function Navigator({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	if (!open) return null;
	return <NavigatorDialog onClose={onClose} />;
}

function NavigatorDialog({ onClose }: { onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState<NavScope>("opened");
	const [statuses, setStatuses] = useState<ReadonlySet<NavStatus>>(NO_STATUSES);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => {
		onClose();
		restoreTerminalFocus();
	}, [onClose]);
	useEscapeKey(close);

	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const gitById = useWorkspaceGitStore((s) => s.byWorkspaceId);
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const activities = usePtyActivityStore((s) => s.activities);
	const panePtyMap = usePtyActivityStore((s) => s.panePtyMap);
	const titles = usePtyActivityStore((s) => s.titles);
	const cwds = usePtyActivityStore((s) => s.cwds);
	const detectedAgentIds = usePtyActivityStore((s) => s.detectedAgentIds);
	const agents = useSettingsStore((s) => s.agents);

	// File windows live in Rust; read them once per open. They cannot change
	// while the dialog has focus, short of a Workspace closing under it.
	const [openWindows, setOpenWindows] = useState<OpenFileWindow[]>([]);
	const openedKey = [...openedWorkspaceIds].sort().join("|");
	useEffect(() => {
		let live = true;
		const ids = openedKey ? openedKey.split("|") : [];
		if (ids.length === 0) return;
		fileWindows
			.list(ids)
			.then((list) => live && setOpenWindows(list))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [openedKey]);

	const order = useMemo(
		() =>
			navigatorWorkspaceOrder(buildWorkspaceRows(workspaces, worktreeFacts)),
		[workspaces, worktreeFacts],
	);
	const agentNames = useMemo(
		() => Object.fromEntries(agents.map((a) => [a.id, a.name])),
		[agents],
	);
	const branches = useMemo(() => {
		const out: Record<string, string | undefined> = {};
		for (const [id, info] of Object.entries(gitById)) {
			if (info?.isGitRepo && info.currentBranch) out[id] = info.currentBranch;
		}
		return out;
	}, [gitById]);

	const rows = useMemo(
		() =>
			navigatorRows({
				workspaces: order,
				openedWorkspaceIds,
				scope,
				query,
				statuses,
				collapsed,
				activities,
				panePtyMap,
				titles,
				cwds,
				detectedAgentIds,
				agentNames,
				branches,
				fileWindows: openWindows,
			}),
		[
			order,
			openedWorkspaceIds,
			scope,
			query,
			statuses,
			collapsed,
			activities,
			panePtyMap,
			titles,
			cwds,
			detectedAgentIds,
			agentNames,
			branches,
			openWindows,
		],
	);

	const workspaceById = useMemo(
		() => new Map(workspaces.map((w) => [w.id, w])),
		[workspaces],
	);

	// Preselect the target pane on open only; afterwards the selection is
	// kept by key so live status changes never move it.
	const initialised = useRef(false);
	useEffect(() => {
		if (initialised.current) return;
		initialised.current = true;
		const i = initialSelection(rows, {
			paneId: targetPaneId(),
			workspaceId: activeWorkspaceId,
		});
		setSelectedKey(rows[i]?.key ?? null);
		inputRef.current?.focus();
	}, [rows, activeWorkspaceId]);

	let selectedIndex = rows.findIndex((r) => r.key === selectedKey);
	if (selectedIndex < 0 && rows.length > 0) selectedIndex = 0;
	const selected = rows[selectedIndex];

	useEffect(() => {
		if (!selected) return;
		const el = Array.from(
			listRef.current?.querySelectorAll<HTMLElement>("[data-nav-key]") ?? [],
		).find((n) => n.dataset.navKey === selected.key);
		el?.scrollIntoView?.({ block: "nearest" });
	}, [selected]);

	const pick = useCallback(
		(row: NavRow) => {
			onClose();
			goTo(row);
			restoreTerminalFocus();
		},
		[onClose],
	);

	const setFolded = useCallback((key: string, fold: boolean) => {
		setCollapsed((prev) => {
			if (prev.has(key) === fold) return prev;
			const next = new Set(prev);
			if (fold) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);

	const toggleStatus = (st: NavStatus) => {
		setStatuses((prev) => {
			const next = new Set(prev);
			if (next.has(st)) next.delete(st);
			else next.add(st);
			return next;
		});
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		const move = (i: number) => {
			const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
			if (row) setSelectedKey(row.key);
		};
		if (e.key === "ArrowDown") {
			e.preventDefault();
			move(selectedIndex + 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			move(selectedIndex - 1);
		} else if (e.key === "Enter" && selected) {
			e.preventDefault();
			pick(selected);
		} else if (query === "" && selected && e.key === "ArrowLeft") {
			// With a search the tree is fully expanded and Left/Right move the
			// caret instead.
			e.preventDefault();
			if (isFolder(selected) && selected.hasChildren && selected.expanded) {
				setFolded(selected.key, true);
			} else {
				const parent = parentKey(selected);
				if (parent) setSelectedKey(parent);
			}
		} else if (query === "" && selected && e.key === "ArrowRight") {
			e.preventDefault();
			if (!isFolder(selected) || !selected.hasChildren) return;
			if (!selected.expanded) setFolded(selected.key, false);
			else move(selectedIndex + 1);
		}
	};

	const empty =
		statuses.size > 0
			? "No Agents in the chosen states"
			: query
				? "No matches"
				: "No opened workspaces";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-start justify-center"
			style={{ paddingTop: 72, backgroundColor: "rgba(0,0,0,0.5)" }}
			onClick={close}
		>
			<div
				role="dialog"
				aria-label="Navigator"
				data-testid="navigator"
				className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
				style={{
					width: 580,
					maxWidth: "calc(100vw - 32px)",
					maxHeight: "70vh",
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<div
					className="flex items-center gap-2"
					style={{
						padding: "10px 14px",
						borderBottom: "1px solid var(--border)",
					}}
				>
					<Search size={15} style={{ color: "var(--fg-secondary)" }} />
					<input
						ref={inputRef}
						type="text"
						placeholder="Go to workspace, tab, agent or terminal…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						aria-label="Search"
						className="flex-1 bg-transparent outline-none"
						style={{
							color: "var(--fg-primary)",
							fontSize: 15,
							padding: "4px 2px",
						}}
					/>
				</div>
				<div
					className="flex items-center gap-2 flex-wrap"
					style={{
						padding: "8px 14px",
						borderBottom: "1px solid var(--border)",
					}}
				>
					<div
						className="flex rounded-md overflow-hidden"
						style={{ border: "1px solid var(--border)" }}
					>
						{(
							[
								["opened", "Opened"],
								["all", "All workspaces"],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								aria-pressed={scope === value}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => setScope(value)}
								className={`transition-colors ${
									scope === value
										? "bg-[var(--row-active-bg)] text-[var(--fg-primary)]"
										: "text-[var(--fg-secondary)] hover:bg-[var(--row-hover-bg)]"
								}`}
								style={{ fontSize: 11.5, padding: "3px 9px" }}
							>
								{label}
							</button>
						))}
					</div>
					<span className="flex-1" />
					<div className="flex items-center gap-1">
						{NAV_STATUSES.map((st) => {
							const on = statuses.has(st);
							return (
								<button
									key={st}
									type="button"
									aria-pressed={on}
									title={`Show only ${STATUS_CHIPS[st].label} agents`}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => toggleStatus(st)}
									className={`flex items-center gap-1 rounded-full transition-colors ${
										on
											? "bg-[var(--row-active-bg)] text-[var(--fg-primary)] border-[var(--accent)]"
											: "text-[var(--fg-secondary)] border-[var(--border)] hover:bg-[var(--row-hover-bg)]"
									}`}
									style={{
										fontSize: 11,
										padding: "2px 8px 2px 6px",
										borderWidth: 1,
										borderStyle: "solid",
									}}
								>
									<AgentStatusIcon status={STATUS_CHIPS[st].icon} size={10} />
									{STATUS_CHIPS[st].label}
								</button>
							);
						})}
					</div>
				</div>
				<div
					ref={listRef}
					role="tree"
					aria-label="Workspaces"
					className="flex-1 overflow-y-auto flex flex-col"
					style={{ padding: "6px 6px" }}
				>
					{rows.length === 0 ? (
						<div
							className="text-center"
							style={{
								color: "var(--fg-secondary)",
								fontSize: 13,
								padding: "20px 0",
							}}
						>
							{empty}
						</div>
					) : (
						rows.map((row, i) => (
							<NavRowView
								key={row.key}
								row={row}
								selected={i === selectedIndex}
								workspace={workspaceById.get(row.workspaceId)}
								status={
									row.kind === "pane" && row.ptyId
										? computePtyDotStatus(row.ptyId, activities)
										: null
								}
								onHover={() => setSelectedKey(row.key)}
								onPick={() => pick(row)}
								onToggle={() =>
									isFolder(row) && setFolded(row.key, row.expanded)
								}
							/>
						))
					)}
				</div>
				<div
					className="flex items-center gap-3"
					style={{
						padding: "6px 14px",
						borderTop: "1px solid var(--border)",
						fontSize: 11,
						color: "var(--fg-secondary)",
					}}
				>
					<span>↑↓ move</span>
					<span>←→ fold</span>
					<span>↵ go</span>
					<span>esc close</span>
				</div>
			</div>
		</div>
	);
}

const NavRowView = memo(function NavRowView({
	row,
	selected,
	workspace,
	status,
	onHover,
	onPick,
	onToggle,
}: {
	row: NavRow;
	selected: boolean;
	workspace: WorkspaceWithTabs | undefined;
	status: DotStatus | null;
	onHover: () => void;
	onPick: () => void;
	onToggle: () => void;
}) {
	const depth =
		(row.kind === "workspace" ? 0 : row.kind === "pane" ? 2 : 1) +
		(row.linked ? 1 : 0);
	const tab =
		row.kind === "tab"
			? workspace?.tabs.find((t) => t.id === row.tabId)
			: undefined;

	return (
		<div
			role="treeitem"
			tabIndex={-1}
			aria-selected={selected}
			aria-expanded={
				isFolder(row) && row.hasChildren ? row.expanded : undefined
			}
			data-nav-key={row.key}
			data-testid="navigator-row"
			onMouseMove={selected ? undefined : onHover}
			onMouseDown={(e) => e.preventDefault()}
			onClick={onPick}
			onKeyDown={undefined}
			className={`flex items-center gap-2 rounded-md cursor-pointer select-none ${
				selected ? "bg-[var(--row-active-bg)]" : ""
			}`}
			style={{
				minHeight: 28,
				padding: `3px 10px 3px ${6 + depth * INDENT}px`,
				borderLeft: selected
					? "2px solid var(--accent)"
					: "2px solid transparent",
			}}
		>
			<span
				className="flex items-center justify-center flex-shrink-0"
				style={{ width: 14 }}
			>
				{isFolder(row) && row.hasChildren && (
					<button
						type="button"
						aria-label={row.expanded ? "Collapse" : "Expand"}
						onMouseDown={(e) => e.preventDefault()}
						onClick={(e) => {
							e.stopPropagation();
							onToggle();
						}}
						className="flex items-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
					>
						{row.expanded ? (
							<ChevronDown size={12} />
						) : (
							<ChevronRight size={12} />
						)}
					</button>
				)}
			</span>
			{row.kind === "workspace" && (
				<WorkspaceLine row={row} workspace={workspace} />
			)}
			{row.kind === "tab" && <TabLine name={row.name} tab={tab} />}
			{row.kind === "pane" && <PaneLine row={row} status={status} />}
			{row.kind === "window" && <WindowLine row={row} />}
		</div>
	);
});

function WorkspaceLine({
	row,
	workspace,
}: {
	row: Extract<NavRow, { kind: "workspace" }>;
	workspace: WorkspaceWithTabs | undefined;
}) {
	return (
		<>
			<Folder
				size={13}
				className="flex-shrink-0"
				style={{ color: "var(--accent)" }}
			/>
			<span
				className="truncate font-medium"
				style={{
					fontSize: 13,
					color: row.opened ? "var(--fg-primary)" : "var(--fg-secondary)",
				}}
			>
				{row.name}
			</span>
			{row.branch && (
				<span
					className="flex items-center gap-1 truncate"
					style={{ fontSize: 11, color: "var(--fg-secondary)", minWidth: 0 }}
				>
					<GitBranch size={10} className="flex-shrink-0" />
					<span className="truncate">{row.branch}</span>
				</span>
			)}
			<span className="flex-1" />
			{!row.opened && (
				<span style={{ fontSize: 10.5, color: "var(--fg-secondary)" }}>
					Not opened
				</span>
			)}
			{workspace && <WorkspaceStatus workspace={workspace} />}
		</>
	);
}

function WorkspaceStatus({ workspace }: { workspace: WorkspaceWithTabs }) {
	const rollups = useWorkspaceRollups(workspace);
	return <StatusComposite rollups={rollups} />;
}

function TabLine({ name, tab }: { name: string; tab: Tab | undefined }) {
	return (
		<>
			<span
				className="truncate"
				style={{ fontSize: 12.5, color: "var(--fg-primary)" }}
			>
				{name}
			</span>
			<span className="flex-1" />
			{tab && <TabStatus tab={tab} />}
		</>
	);
}

function TabStatus({ tab }: { tab: Tab }) {
	const rollups = useTabRollups(tab);
	return <StatusComposite rollups={rollups} />;
}

function PaneLine({
	row,
	status,
}: {
	row: Extract<NavRow, { kind: "pane" }>;
	status: DotStatus | null;
}) {
	const AgentIcon =
		(row.agentId && getAgentIconComponent(row.agentId)) || undefined;
	return (
		<>
			{status && <AgentStatusIcon status={status} size={12} />}
			<span
				className="flex items-center flex-shrink-0"
				style={{ color: "var(--fg-secondary)" }}
			>
				{row.paneKind === "agent" &&
					(AgentIcon ? (
						<AgentIcon size={13} />
					) : (
						<FallbackAgentIcon size={12} />
					))}
				{row.paneKind === "terminal" && <SquareTerminal size={13} />}
				{row.paneKind === "file" && <FileText size={13} />}
				{row.paneKind === "preview" && <Eye size={13} />}
			</span>
			<span
				className="truncate"
				style={{ fontSize: 12.5, color: "var(--fg-primary)" }}
			>
				{row.label}
			</span>
		</>
	);
}

function WindowLine({ row }: { row: Extract<NavRow, { kind: "window" }> }) {
	return (
		<>
			<span
				className="flex items-center flex-shrink-0"
				style={{ color: "var(--fg-secondary)" }}
				title="Separate window"
			>
				<AppWindow size={13} />
			</span>
			<span
				className="truncate"
				style={{ fontSize: 12.5, color: "var(--fg-primary)" }}
			>
				{row.label}
			</span>
			<span className="flex-1" />
			<span style={{ fontSize: 10.5, color: "var(--fg-secondary)" }}>
				Window
			</span>
		</>
	);
}
