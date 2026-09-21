import { open } from "@tauri-apps/plugin-shell";
import { useEffect, useState } from "react";
import {
	commitMenuEntries,
	commitTooltip,
	githubCommitUrl,
	initials,
	relativeTime,
} from "../../lib/branchCommits";
import { writeClipboardText } from "../../lib/clipboard";
import { git } from "../../lib/ipc";
import type { BranchCommit, CommitFile } from "../../lib/types";
import { useExplorerStore } from "../../stores/explorerStore";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { ChevronDown, ChevronRight, GitCommit } from "../Icons";
import type { ContextMenuItem } from "../Terminal/PaneContextMenu";
import { PaneContextMenu } from "../Terminal/PaneContextMenu";

const HEADER_HEIGHT = 30;
const ROW_HEIGHT = 26;
const FILE_ROW_HEIGHT = 24;
/** The branch rail runs down this gutter; nodes sit on it. */
const GUTTER = 22;
const RAIL_X = 12;

const STATUS_COLORS: Record<string, string> = {
	A: "var(--success)",
	M: "var(--warning)",
	D: "var(--error)",
	R: "var(--accent)",
};

// A commit's file list never changes, so it is fetched once per commit per
// repository for the life of the window. Keyed by cwd too: two Workspaces can
// hold the same oid (a Worktree set shares its objects) but not the same root.
const commitFilesCache = new Map<string, CommitFile[]>();
const filesKey = (cwd: string, oid: string) => `${cwd}\0${oid}`;

/** Re-render once a minute so "now" becomes "1m" without a git refresh. */
function useNowSecs(): number {
	const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
	useEffect(() => {
		const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
		return () => clearInterval(id);
	}, []);
	return now;
}

/** The **Branch commits** Anchored section: the commits on the Active
 *  workspace's branch that its base does not have yet. See CONTEXT.md.
 *  Like `PrSection`, it always renders its header; the body is hidden when
 *  collapsed and the parent sizes it. */
export function CommitsSection() {
	const collapsed = useWindowUiStore((s) => s.commitsSectionCollapsed);
	const toggle = useWindowUiStore((s) => s.toggleCommitsSectionCollapsed);
	const branchCommits = useGitChangesStore((s) => s.branchCommits);
	const baseBranch = useGitChangesStore((s) => s.baseBranch);

	const base = branchCommits?.base ?? baseBranch;
	const count = branchCommits?.total;

	return (
		<div
			className="flex flex-col min-h-0"
			style={{
				borderTop: collapsed ? "1px solid var(--border)" : "none",
				backgroundColor: "transparent",
				flex: "1 1 0%",
			}}
		>
			<button
				type="button"
				onClick={toggle}
				className="flex items-center gap-1.5 flex-shrink-0 transition-colors"
				style={{
					height: HEADER_HEIGHT,
					paddingLeft: 10,
					paddingRight: 10,
					borderBottom: collapsed ? "none" : "1px solid var(--border)",
					color: "var(--fg-secondary)",
					transitionDuration: "var(--transition-fast)",
					cursor: "pointer",
					textAlign: "left",
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.backgroundColor = "transparent";
				}}
				title={collapsed ? "Expand Branch Commits" : "Collapse Branch Commits"}
			>
				{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
				<GitCommit size={12} style={{ color: "var(--accent)" }} />
				<span
					className="font-semibold"
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						letterSpacing: "0.05em",
						textTransform: "uppercase",
					}}
				>
					Branch Commits
				</span>
				{count != null && (
					<span
						style={{
							fontSize: 11,
							color: "var(--fg-secondary)",
							fontVariantNumeric: "tabular-nums",
						}}
					>
						({count.toLocaleString()})
					</span>
				)}
				<span className="flex-1" />
				{base && (
					<span
						className="truncate"
						style={{
							fontSize: 10.5,
							color: "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
							opacity: 0.8,
							minWidth: 0,
						}}
					>
						vs {base}
					</span>
				)}
			</button>

			{!collapsed && (
				<div className="flex-1 min-h-0 overflow-y-auto">
					<CommitsBody />
				</div>
			)}
		</div>
	);
}

function Message({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="flex items-center justify-center text-center"
			style={{
				minHeight: 56,
				fontSize: 12,
				color: "var(--fg-secondary)",
				padding: "8px 16px",
			}}
		>
			{children}
		</div>
	);
}

function CommitsBody() {
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const cwd = useWorkspaceStore(
		(s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.rootFolder,
	);
	const isGitRepo = useWorkspaceGitStore((s) =>
		activeWorkspaceId
			? s.byWorkspaceId[activeWorkspaceId]?.isGitRepo
			: undefined,
	);
	const slug = useWorkspaceGitStore((s) =>
		activeWorkspaceId
			? (s.repoSlugsById[activeWorkspaceId]?.[0] ?? null)
			: null,
	);
	const branchCommits = useGitChangesStore((s) => s.branchCommits);
	const currentBranch = useGitChangesStore((s) => s.currentBranch);
	const error = useGitChangesStore((s) => s.error);
	const now = useNowSecs();

	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [files, setFiles] = useState<Record<string, CommitFile[] | "loading">>(
		{},
	);
	// Captured by value, like the Git changes Row menu: a refresh that drops
	// the commit (a rebase) leaves the menu open and its actions still right.
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		commit: BranchCommit;
		fromKeyboard: boolean;
	} | null>(null);

	// Expansion and menus belong to one Workspace's history.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets on switch only
	useEffect(() => {
		setExpanded(new Set());
		setFiles({});
		setMenu(null);
	}, [activeWorkspaceId]);

	if (!activeWorkspaceId || !cwd) return null;
	if (isGitRepo === false) return <Message>Not a git repository</Message>;
	if (!branchCommits) {
		// A bundle has arrived (it names the branch) yet carried no commit
		// list: the base branch does not resolve to a commit.
		if (currentBranch || error) return <Message>Base branch not found</Message>;
		return (
			<Message>
				<span className="animate-pulse">Loading commits…</span>
			</Message>
		);
	}
	if (branchCommits.total === 0) {
		return <Message>No commits ahead of {branchCommits.base}</Message>;
	}

	async function toggleCommit(oid: string) {
		if (!cwd) return;
		const next = new Set(expanded);
		if (next.has(oid)) {
			next.delete(oid);
			setExpanded(next);
			return;
		}
		next.add(oid);
		setExpanded(next);
		const key = filesKey(cwd, oid);
		const cached = commitFilesCache.get(key);
		if (cached) {
			setFiles((f) => ({ ...f, [oid]: cached }));
			return;
		}
		setFiles((f) => ({ ...f, [oid]: "loading" }));
		try {
			const list = await git.commitFiles(cwd, oid);
			commitFilesCache.set(key, list);
			setFiles((f) => ({ ...f, [oid]: list }));
		} catch {
			setFiles((f) => ({ ...f, [oid]: [] }));
		}
	}

	async function openFileDiff(commit: BranchCommit, file: CommitFile) {
		if (!cwd || !activeWorkspaceId) return;
		try {
			const diff = await git.commitFileDiff(cwd, commit.oid, file.path);
			useExplorerStore
				.getState()
				.openCommitDiff(
					activeWorkspaceId,
					commit.oid,
					file.path,
					diff.original,
					diff.modified,
					file.status === "D",
				);
		} catch {
			// The commit is gone (rebased away) — the next refresh drops its row.
		}
	}

	function buildMenuItems(): ContextMenuItem[] {
		if (!menu) return [];
		const { commit } = menu;
		const close = () => setMenu(null);
		const run = {
			"copy-hash": () => {
				close();
				writeClipboardText(commit.oid).catch(console.error);
			},
			"open-on-github": () => {
				close();
				if (slug) open(githubCommitUrl(slug, commit.oid)).catch(console.error);
			},
		};
		return commitMenuEntries(commit, slug).map((entry) => ({
			label: entry.label,
			disabled: entry.disabled,
			onClick: run[entry.id],
		}));
	}

	const hidden = branchCommits.total - branchCommits.commits.length;

	return (
		<>
			<ul style={{ paddingTop: 4, listStyle: "none" }}>
				{branchCommits.commits.map((commit, i) => {
					const isOpen = expanded.has(commit.oid);
					const fileList = files[commit.oid];
					return (
						<li key={commit.oid}>
							<CommitRow
								commit={commit}
								isHead={i === 0}
								isOpen={isOpen}
								isMenuTarget={menu?.commit.oid === commit.oid}
								now={now}
								onToggle={() => toggleCommit(commit.oid)}
								onContextMenu={(x, y, fromKeyboard) =>
									setMenu({ x, y, commit, fromKeyboard })
								}
							/>
							{isOpen &&
								(fileList === "loading" || fileList === undefined ? (
									<RailLine muted>
										<span className="animate-pulse">Loading files…</span>
									</RailLine>
								) : fileList.length === 0 ? (
									<RailLine muted>No file changes</RailLine>
								) : (
									fileList.map((f) => (
										<CommitFileRow
											key={f.path}
											file={f}
											onOpen={() => openFileDiff(commit, f)}
										/>
									))
								))}
						</li>
					);
				})}
				{hidden > 0 && (
					<li>
						<RailLine muted>{hidden.toLocaleString()} more not shown</RailLine>
					</li>
				)}
				<li>
					<BaseTerminus base={branchCommits.base} />
				</li>
			</ul>
			{menu && (
				<PaneContextMenu
					x={menu.x}
					y={menu.y}
					items={buildMenuItems()}
					autoFocus={menu.fromKeyboard}
					onClose={() => setMenu(null)}
				/>
			)}
		</>
	);
}

/** The vertical line every row draws through its gutter, so the list reads
 *  as one branch running down to where it left its base. */
function Rail({ top = 0, bottom = 0 }: { top?: number; bottom?: number }) {
	return (
		<span
			aria-hidden
			style={{
				position: "absolute",
				left: RAIL_X,
				top,
				bottom,
				width: 1,
				backgroundColor: "color-mix(in srgb, var(--accent) 35%, var(--border))",
			}}
		/>
	);
}

/** HEAD is solid; the rest are rings. A merge is a diamond, because it is
 *  where another line of history joined this one. */
function CommitNode({
	isHead,
	isMerge,
}: {
	isHead: boolean;
	isMerge: boolean;
}) {
	const size = isMerge ? 7 : 8;
	return (
		<span
			aria-hidden
			style={{
				position: "absolute",
				left: RAIL_X + 0.5 - size / 2,
				top: ROW_HEIGHT / 2 - size / 2,
				width: size,
				height: size,
				borderRadius: isMerge ? 1 : "50%",
				transform: isMerge ? "rotate(45deg)" : undefined,
				border: "1.5px solid var(--accent)",
				backgroundColor: isHead ? "var(--accent)" : "var(--bg-secondary)",
				boxSizing: "border-box",
			}}
		/>
	);
}

function CommitRow({
	commit,
	isHead,
	isOpen,
	isMenuTarget,
	now,
	onToggle,
	onContextMenu,
}: {
	commit: BranchCommit;
	isHead: boolean;
	isOpen: boolean;
	isMenuTarget: boolean;
	now: number;
	onToggle: () => void;
	onContextMenu: (x: number, y: number, fromKeyboard: boolean) => void;
}) {
	return (
		<button
			type="button"
			aria-expanded={isOpen}
			aria-haspopup="menu"
			title={commitTooltip(commit)}
			onClick={onToggle}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onContextMenu(e.clientX, e.clientY, false);
			}}
			onKeyDown={(e) => {
				if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
					e.preventDefault();
					const rect = e.currentTarget.getBoundingClientRect();
					onContextMenu(rect.left + 12, rect.bottom, true);
				}
			}}
			className="group relative w-full flex items-center gap-1.5 text-left select-none transition-colors"
			style={{
				height: ROW_HEIGHT,
				paddingLeft: GUTTER,
				paddingRight: 10,
				background: "transparent",
				border: "none",
				cursor: "pointer",
				boxShadow: isMenuTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.backgroundColor =
					"color-mix(in srgb, var(--bg-tertiary) 60%, transparent)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<Rail top={isHead ? ROW_HEIGHT / 2 : 0} />
			<CommitNode isHead={isHead} isMerge={commit.isMerge} />
			<span
				className="flex-shrink-0 transition-opacity opacity-40 group-hover:opacity-80"
				style={{ display: "inline-flex", color: "var(--fg-secondary)" }}
			>
				{isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
			</span>
			<span
				className="truncate flex-1 min-w-0"
				style={{
					fontSize: 12,
					color: "var(--fg-primary)",
					fontFamily: "var(--font-ui)",
					fontWeight: isHead ? 500 : 400,
				}}
			>
				{commit.subject || (
					<span style={{ color: "var(--fg-secondary)" }}>(no message)</span>
				)}
			</span>
			<span
				className="flex-shrink-0 inline-flex items-center justify-center rounded"
				style={{
					minWidth: 20,
					height: 16,
					padding: "0 3px",
					fontSize: 9.5,
					fontWeight: 600,
					letterSpacing: "0.03em",
					color: "var(--fg-secondary)",
					backgroundColor:
						"color-mix(in srgb, var(--fg-secondary) 12%, transparent)",
				}}
			>
				{initials(commit.authorName)}
			</span>
			<span
				className="flex-shrink-0 text-right"
				style={{
					width: 26,
					fontSize: 11,
					color: "var(--fg-secondary)",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{relativeTime(commit.time, now)}
			</span>
		</button>
	);
}

function CommitFileRow({
	file,
	onOpen,
}: {
	file: CommitFile;
	onOpen: () => void;
}) {
	const color = STATUS_COLORS[file.status] ?? "var(--fg-secondary)";
	const name = file.path.split("/").pop() ?? file.path;
	const dir = file.path.includes("/")
		? file.path.slice(0, file.path.lastIndexOf("/"))
		: "";
	return (
		<button
			type="button"
			onClick={onOpen}
			title={`Open diff of ${file.path} at this commit`}
			className="relative w-full flex items-center gap-2 text-left select-none transition-colors"
			style={{
				height: FILE_ROW_HEIGHT,
				paddingLeft: GUTTER + 14,
				paddingRight: 10,
				background: "transparent",
				border: "none",
				cursor: "pointer",
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.backgroundColor =
					"color-mix(in srgb, var(--bg-tertiary) 60%, transparent)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<Rail />
			<span
				className="flex-shrink-0 inline-flex items-center justify-center rounded font-bold"
				style={{
					width: 16,
					height: 16,
					fontSize: 9.5,
					color,
					backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
				}}
			>
				{file.status}
			</span>
			<span
				className="truncate flex-1 min-w-0"
				style={{ fontSize: 11.5, color: "var(--fg-primary)" }}
			>
				{name}
				{dir && (
					<span style={{ color: "var(--fg-secondary)", marginLeft: 4 }}>
						{dir}
					</span>
				)}
			</span>
			<span
				className="flex-shrink-0 flex items-center gap-1"
				style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}
			>
				{file.additions > 0 && (
					<span style={{ color: "var(--success)" }}>+{file.additions}</span>
				)}
				{file.deletions > 0 && (
					<span style={{ color: "var(--error)" }}>−{file.deletions}</span>
				)}
			</span>
		</button>
	);
}

/** A rail-continuing line with no node: loading, empty, "N more". */
function RailLine({
	children,
	muted,
}: {
	children: React.ReactNode;
	muted?: boolean;
}) {
	return (
		<div
			className="relative flex items-center"
			style={{
				height: FILE_ROW_HEIGHT,
				paddingLeft: GUTTER + 14,
				fontSize: 11,
				color: muted ? "var(--fg-secondary)" : "var(--fg-primary)",
				fontStyle: muted ? "italic" : undefined,
			}}
		>
			<Rail />
			{children}
		</div>
	);
}

/** Where the rail ends: the merge-base with the base branch. */
function BaseTerminus({ base }: { base: string }) {
	return (
		<div
			className="relative flex items-center gap-1.5"
			style={{ height: ROW_HEIGHT, paddingLeft: GUTTER, paddingBottom: 2 }}
			title={`Where this branch left ${base} (the merge-base)`}
		>
			<Rail bottom={ROW_HEIGHT / 2} />
			<span
				aria-hidden
				style={{
					position: "absolute",
					left: RAIL_X + 0.5 - 4,
					top: ROW_HEIGHT / 2 - 1,
					width: 8,
					height: 1,
					backgroundColor: "var(--fg-secondary)",
					opacity: 0.6,
				}}
			/>
			<span
				style={{
					fontSize: 10.5,
					color: "var(--fg-secondary)",
					fontFamily: "var(--font-mono)",
					opacity: 0.8,
				}}
			>
				{base}
			</span>
		</div>
	);
}
