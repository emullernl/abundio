import { open } from "@tauri-apps/plugin-shell";
import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import {
	COMMIT_HISTORY_CAP,
	commitMenuEntries,
	commitTooltip,
	githubCommitUrl,
	historySummary,
	initials,
	relativeTime,
} from "../../lib/commitHistory";
import { gitRowMenuEntries } from "../../lib/gitRowMenu";
import { fs as fsApi, git } from "../../lib/ipc";
import { resolveWorkspacePath } from "../../lib/resolveWorkspacePath";
import type { CommitFile, HistoryCommit } from "../../lib/types";
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
// repository. Keyed by cwd too: two Workspaces can hold the same oid (a
// Worktree set shares its objects) but not the same root. Bounded, because one
// merge of a long-lived branch can touch tens of thousands of files and the
// backing call is cheap to repeat: past the cap it is simply emptied.
const COMMIT_FILES_CACHE_CAP = 100;
const commitFilesCache = new Map<string, CommitFile[]>();
const filesKey = (cwd: string, oid: string) => `${cwd}\0${oid}`;
function rememberCommitFiles(key: string, list: CommitFile[]) {
	if (commitFilesCache.size >= COMMIT_FILES_CACHE_CAP) commitFilesCache.clear();
	commitFilesCache.set(key, list);
}

/** Re-render once a minute so "now" becomes "1m" without a git refresh. */
function useNowSecs(): number {
	const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
	useEffect(() => {
		const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
		return () => clearInterval(id);
	}, []);
	return now;
}

/** The **Commits** Anchored section: the Active workspace's recent history —
 *  its **Ahead commits**, a divider named after the base, then the **Shared
 *  history**. See CONTEXT.md.
 *  Like `PrSection`, it always renders its header; the body is hidden when
 *  collapsed and the parent sizes it. */
export function CommitsSection() {
	const collapsed = useWindowUiStore((s) => s.commitsSectionCollapsed);
	const toggle = useWindowUiStore((s) => s.toggleCommitsSectionCollapsed);
	const commitHistory = useGitChangesStore((s) => s.commitHistory);
	const summary = commitHistory ? historySummary(commitHistory) : null;

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
				title={collapsed ? "Expand Commits" : "Collapse Commits"}
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
					Commits
				</span>
				<span className="flex-1" />
				{summary && (
					<span
						className="truncate"
						title={
							commitHistory?.base
								? undefined
								: "The base branch could not be resolved, so nothing is marked as ahead"
						}
						style={{
							fontSize: 10.5,
							color: "var(--fg-secondary)",
							fontVariantNumeric: "tabular-nums",
							opacity: 0.8,
							minWidth: 0,
						}}
					>
						{summary}
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
	const commitHistory = useGitChangesStore((s) => s.commitHistory);
	// From the same remote `onRemote` was judged against, so a fork checkout
	// never links a commit to the repository that does not have it.
	const slug = commitHistory?.githubSlug ?? null;
	const currentBranch = useGitChangesStore((s) => s.currentBranch);
	const error = useGitChangesStore((s) => s.error);
	const now = useNowSecs();

	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	// The source of truth for toggles. Two clicks in one batch (a double-click)
	// must each see the other's result, which render-closure state cannot give.
	const expandedRef = useRef<Set<string>>(new Set());
	const [files, setFiles] = useState<
		Record<string, CommitFile[] | "loading" | "error">
	>({});
	// Captured by value, like the Git changes Row menu: a refresh that drops
	// the commit (a rebase) leaves the menu open and its actions still right.
	// A file row inside an expanded commit gets the Git changes **Row menu**;
	// the commit row itself gets the commit menu.
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		commit: HistoryCommit;
		file?: CommitFile;
		fromKeyboard: boolean;
	} | null>(null);

	// Expansion and menus belong to one Workspace's history.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resets on switch only
	useEffect(() => {
		expandedRef.current = new Set();
		setExpanded(new Set());
		setFiles({});
		setMenu(null);
	}, [activeWorkspaceId]);

	if (!activeWorkspaceId || !cwd) return null;
	if (isGitRepo === false) return <Message>Not a git repository</Message>;
	if (!commitHistory) {
		// A failed refresh says why.
		if (error) return <Message>Could not read commits: {error}</Message>;
		// A bundle arrived (it names the branch) without a commit list. An
		// unknown base no longer causes this — the list is sent without one —
		// so it is a read failure of its own.
		if (currentBranch) return <Message>Could not read commits</Message>;
		return (
			<Message>
				<span className="animate-pulse">Loading commits…</span>
			</Message>
		);
	}
	if (commitHistory.commits.length === 0) {
		return <Message>No commits yet</Message>;
	}

	async function toggleCommit(oid: string) {
		if (!cwd) return;
		const next = new Set(expandedRef.current);
		const wasOpen = next.delete(oid);
		if (!wasOpen) next.add(oid);
		expandedRef.current = next;
		setExpanded(next);
		if (wasOpen) {
			// Forget the entry so re-expanding retries a failed read; a good
			// list comes straight back from the module cache.
			setFiles(({ [oid]: _drop, ...rest }) => rest);
			return;
		}
		const key = filesKey(cwd, oid);
		const cached = commitFilesCache.get(key);
		if (cached) {
			setFiles((f) => ({ ...f, [oid]: cached }));
			return;
		}
		setFiles((f) => ({ ...f, [oid]: "loading" }));
		try {
			const list = await git.commitFiles(cwd, oid);
			rememberCommitFiles(key, list);
			setFiles((f) => ({ ...f, [oid]: list }));
		} catch (e) {
			console.error(e);
			// Not `[]`: that would read as "this commit changed nothing".
			setFiles((f) => ({ ...f, [oid]: "error" }));
		}
	}

	async function openFileDiff(commit: HistoryCommit, file: CommitFile) {
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
		} catch (e) {
			// Usually the commit is gone (rebased away) and the next refresh
			// drops its row — but say so, since a click that does nothing is
			// otherwise indistinguishable from any other failure.
			console.error(e);
		}
	}

	function openFileNow(file: CommitFile) {
		if (!cwd || !activeWorkspaceId) return;
		useExplorerStore
			.getState()
			.openFile(activeWorkspaceId, resolveWorkspacePath(cwd, file.path))
			.catch(() => {
				// The file is not on disk any more — nothing to open.
			});
	}

	function buildFileMenuItems(
		commit: HistoryCommit,
		file: CommitFile,
	): ContextMenuItem[] {
		const root = cwd ?? "";
		const close = () => setMenu(null);
		// The same menu as a Git changes row, in the same shape. "Open Diff" is
		// the commit's diff; "Open File" and the paths are the file as it is on
		// disk now. A path the commit deleted is disabled like a deleted row.
		const run: Record<string, () => void> = {
			"open-diff": () => {
				close();
				openFileDiff(commit, file);
			},
			"open-file": () => {
				close();
				openFileNow(file);
			},
			reveal: () => {
				close();
				fsApi
					.revealInFolder(resolveWorkspacePath(root, file.path))
					.catch(console.error);
			},
			"copy-relative-path": () => {
				close();
				writeClipboardText(file.path).catch(console.error);
			},
			"copy-path": () => {
				close();
				writeClipboardText(resolveWorkspacePath(root, file.path)).catch(
					console.error,
				);
			},
		};
		return gitRowMenuEntries({ ...file, section: "commit" }).map((entry) =>
			"separator" in entry
				? { separator: true as const }
				: {
						label: entry.label,
						disabled: entry.disabled,
						onClick: run[entry.id],
					},
		);
	}

	function buildMenuItems(): ContextMenuItem[] {
		if (!menu) return [];
		const { commit } = menu;
		if (menu.file) return buildFileMenuItems(commit, menu.file);
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

	const atCap = commitHistory.commits.length >= COMMIT_HISTORY_CAP;
	const { base } = commitHistory;

	return (
		<>
			<ul style={{ paddingTop: 4, listStyle: "none" }}>
				{commitHistory.commits.map((commit, i) => {
					const isOpen = expanded.has(commit.oid);
					const fileList = files[commit.oid];
					// The divider sits on the boundary only: never above the first
					// row (on the base branch everything is shared) and never when
					// the base is unknown (then nothing is).
					const divider =
						base != null &&
						commit.shared &&
						i > 0 &&
						!commitHistory.commits[i - 1].shared;
					return (
						<li key={commit.oid}>
							{divider && <BaseDivider base={base} />}
							<CommitRow
								commit={commit}
								isHead={i === 0}
								isOpen={isOpen}
								isMenuTarget={menu?.commit.oid === commit.oid && !menu.file}
								now={now}
								onToggle={() => toggleCommit(commit.oid)}
								onContextMenu={(x, y, fromKeyboard) =>
									setMenu({ x, y, commit, fromKeyboard })
								}
							/>
							{isOpen &&
								(fileList === "loading" || fileList === undefined ? (
									<RailLine muted shared={commit.shared}>
										<span className="animate-pulse">Loading files…</span>
									</RailLine>
								) : fileList === "error" ? (
									<RailLine muted shared={commit.shared}>
										Could not read this commit's files
									</RailLine>
								) : fileList.length === 0 ? (
									<RailLine muted shared={commit.shared}>
										No file changes
									</RailLine>
								) : (
									fileList.map((f) => (
										<CommitFileRow
											key={f.path}
											file={f}
											shared={commit.shared}
											isMenuTarget={
												menu?.commit.oid === commit.oid &&
												menu.file?.path === f.path
											}
											onOpen={() => openFileDiff(commit, f)}
											onContextMenu={(x, y, fromKeyboard) =>
												setMenu({ x, y, commit, file: f, fromKeyboard })
											}
										/>
									))
								))}
						</li>
					);
				})}
				{atCap && (
					<li>
						<RailLine
							muted
							shared={
								commitHistory.commits[commitHistory.commits.length - 1].shared
							}
						>
							Showing the latest {COMMIT_HISTORY_CAP} commits
						</RailLine>
					</li>
				)}
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

const AHEAD_RAIL = "color-mix(in srgb, var(--accent) 35%, var(--border))";
const SHARED_RAIL = "var(--border)";
const SHARED_NODE = "color-mix(in srgb, var(--fg-secondary) 55%, transparent)";
/** `--border` alone vanishes against the sidebar's glow at 1px. */
const DIVIDER_LINE = "color-mix(in srgb, var(--fg-secondary) 45%, transparent)";

/** The vertical line every row draws through its gutter, so the list reads
 *  as one line of history. Accent through the **Ahead commits**, grey
 *  through the **Shared history**. */
function Rail({
	top = 0,
	bottom = 0,
	shared = false,
}: {
	top?: number;
	bottom?: number;
	shared?: boolean;
}) {
	return (
		<span
			aria-hidden
			style={{
				position: "absolute",
				left: RAIL_X,
				top,
				bottom,
				width: 1,
				backgroundColor: shared ? SHARED_RAIL : AHEAD_RAIL,
			}}
		/>
	);
}

/** HEAD is solid; the rest are rings. A merge is a diamond, because it is
 *  where another line of history joined this one. */
function CommitNode({
	isHead,
	isMerge,
	shared,
}: {
	isHead: boolean;
	isMerge: boolean;
	shared: boolean;
}) {
	const size = isMerge ? 7 : 8;
	const color = shared ? SHARED_NODE : "var(--accent)";
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
				border: `1.5px solid ${color}`,
				backgroundColor: isHead ? color : "var(--bg-secondary)",
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
	commit: HistoryCommit;
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
			<Rail top={isHead ? ROW_HEIGHT / 2 : 0} shared={commit.shared} />
			<CommitNode
				isHead={isHead}
				isMerge={commit.isMerge}
				shared={commit.shared}
			/>
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
	shared,
	isMenuTarget,
	onOpen,
	onContextMenu,
}: {
	file: CommitFile;
	shared: boolean;
	/** The row the Row menu is open on: a ring, like a Git changes row. */
	isMenuTarget: boolean;
	onOpen: () => void;
	onContextMenu: (x: number, y: number, fromKeyboard: boolean) => void;
}) {
	const color = STATUS_COLORS[file.status] ?? "var(--fg-secondary)";
	const name = file.path.split("/").pop() ?? file.path;
	const dir = file.path.includes("/")
		? file.path.slice(0, file.path.lastIndexOf("/"))
		: "";
	// A text diff of a binary blob is only replacement characters, so the row
	// says what it is instead of opening a pane full of them. `aria-disabled`,
	// not `disabled`: a disabled button receives no right-click, and the Row
	// menu's path actions still apply to a binary file.
	const binary = file.isBinary;
	const submodule = file.isSubmodule;
	// Rows with nothing to show as text: a binary blob or a submodule pointer.
	const noDiff = binary || submodule;
	return (
		<button
			type="button"
			onClick={noDiff ? undefined : onOpen}
			aria-disabled={noDiff || undefined}
			aria-haspopup="menu"
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
			title={
				submodule
					? `${file.path} is a submodule — this commit moved it to another commit of that repository`
					: binary
						? `${file.path} is a binary file`
						: `Open diff of ${file.path} at this commit`
			}
			className="relative w-full flex items-center gap-2 text-left select-none transition-colors"
			style={{
				height: FILE_ROW_HEIGHT,
				paddingLeft: GUTTER + 14,
				paddingRight: 10,
				background: "transparent",
				border: "none",
				boxShadow: isMenuTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
				cursor: noDiff ? "default" : "pointer",
				opacity: noDiff ? 0.6 : 1,
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
			<Rail shared={shared} />
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
				{noDiff && (
					<span style={{ color: "var(--fg-secondary)" }}>
						{submodule ? "submodule" : "binary"}
					</span>
				)}
				{!noDiff && file.additions > 0 && (
					<span style={{ color: "var(--success)" }}>+{file.additions}</span>
				)}
				{!noDiff && file.deletions > 0 && (
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
	shared = false,
}: {
	children: React.ReactNode;
	muted?: boolean;
	shared?: boolean;
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
			<Rail shared={shared} />
			{children}
		</div>
	);
}

/** The boundary between the **Ahead commits** and the **Shared history**,
 *  named after the base. The rail changes colour across it. */
function BaseDivider({ base }: { base: string }) {
	return (
		<div
			className="relative flex items-center gap-2"
			style={{ height: 22, paddingLeft: GUTTER, paddingRight: 10 }}
			title={`Below: history ${base} also has, as this branch last saw it`}
		>
			<Rail bottom={11} />
			<Rail top={11} shared />
			<span
				aria-hidden
				className="flex-1"
				style={{ height: 1, backgroundColor: DIVIDER_LINE }}
			/>
			<span
				style={{
					fontSize: 10.5,
					color: "var(--fg-secondary)",
					fontFamily: "var(--font-mono)",
				}}
			>
				{base}
			</span>
			<span
				aria-hidden
				style={{ width: 16, height: 1, backgroundColor: DIVIDER_LINE }}
			/>
		</div>
	);
}
