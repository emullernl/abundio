import { useEffect, useState } from "react";
import type { ConflictBlock, ResolveChoice } from "../../lib/conflictMarkers";
import { fs, type GitConflictFile, git } from "../../lib/ipc";
import { useGitChangesStore } from "../../stores/gitChangesStore";

/** `.git/index` is deliberately excluded from the file watcher (read-only git
 *  commands touch it constantly), so the Rust scheduler never observes a
 *  staging write — every stage must refresh the tab itself. */
async function refreshGitChanges(cwd: string) {
	const store = useGitChangesStore.getState();
	await store.fetchChanges(cwd, store.baseBranch);
}

interface Props {
	paneId: string;
	cwd: string;
	/** Repo-relative — the form every git command takes. */
	relativePath: string;
	/** Absolute — the form the filesystem commands take. */
	absolutePath: string;
	blocks: ConflictBlock[];
	isDirty: boolean;
	onAcceptAll: (choice: ResolveChoice) => void;
	onResolveAndStage: () => Promise<void>;
	mergeViewOpen: boolean;
	onToggleMergeView: () => void;
	onToggleBase: () => void;
	/** Index of the block under the caret, or null when the caret is elsewhere. */
	activeBlock: number | null;
	/** Move the caret to a block and reveal it. Drives the side panes too. */
	onNavigate: (blockIndex: number) => void;
}

/**
 * Actions for a conflicted file.
 *
 * Visibility is decided by the *caller*, from the index — not from whether the
 * buffer still has markers. An agent that resolves the markers in the next pane
 * must not make the staging button disappear. Markers only pick the mode.
 * See ADR-0029.
 */
export function ConflictToolbar({
	cwd,
	relativePath,
	absolutePath,
	blocks,
	isDirty,
	onAcceptAll,
	onResolveAndStage,
	mergeViewOpen,
	onToggleMergeView,
	onToggleBase,
	activeBlock,
	onNavigate,
}: Props) {
	const [staged, setStaged] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<GitConflictFile | null>(null);
	const operation = useGitChangesStore((s) => s.operationInProgress);

	const hasMarkers = blocks.length > 0;
	// The ancestor pane only exists when the merge had a common ancestor — an
	// add/add conflict has no stage 1 to show.
	const conflictHasBase = conflict === null || conflict.kind !== "both_added";

	// Only the marker-less cases need the stages: which kind of conflict this is
	// cannot be read off a file that has no markers to read.
	useEffect(() => {
		if (hasMarkers) {
			setConflict(null);
			return;
		}
		let cancelled = false;
		git
			.conflictFile(cwd, relativePath)
			.then((c) => {
				if (!cancelled) setConflict(c);
			})
			.catch(() => {
				if (!cancelled) setConflict(null);
			});
		return () => {
			cancelled = true;
		};
	}, [cwd, relativePath, hasMarkers]);

	async function run(fn: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await fn();
			setStaged(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	if (staged) {
		return (
			<Bar>
				<span style={{ color: "var(--fg-primary)" }}>Staged.</span>
				<span style={{ color: "var(--fg-secondary)" }}>
					Finish the {operation ?? "merge"} with
				</span>
				<code style={{ fontFamily: "var(--font-mono)" }}>
					git{" "}
					{operation === "cherry_pick" ? "cherry-pick" : (operation ?? "merge")}{" "}
					--continue
				</code>
			</Bar>
		);
	}

	// Binary: choosing a side means writing a blob to the worktree, which is a
	// bigger write than "save the buffer, git add". Out of scope by design.
	if (!hasMarkers && conflict?.isBinary) {
		return (
			<Bar>
				<span style={{ color: "var(--fg-secondary)" }}>
					Binary conflict — resolve in a terminal.
				</span>
			</Bar>
		);
	}

	// A delete conflict has no markers to resolve, only a decision. The copy
	// names neither side: "deleted by them" is backwards during a rebase, and
	// these files carry no marker labels to read the truth from.
	const isDeleteConflict =
		conflict?.kind === "deleted_by_us" || conflict?.kind === "deleted_by_them";

	if (!hasMarkers && isDeleteConflict) {
		return (
			<Bar>
				<span style={{ color: "var(--fg-primary)" }}>
					This file was changed on one side of the merge and deleted on the
					other.
				</span>
				<div className="flex-1" />
				<Button
					disabled={busy}
					onClick={() =>
						run(async () => {
							await onResolveAndStage();
						})
					}
				>
					Keep the file
				</Button>
				<Button
					disabled={busy}
					onClick={() =>
						run(async () => {
							await fs.deletePath(absolutePath);
							await git.stagePath(cwd, relativePath);
							await refreshGitChanges(cwd);
						})
					}
				>
					Delete the file
				</Button>
				{error && <Err>{error}</Err>}
			</Bar>
		);
	}

	// Wrap around: with a handful of conflicts, hitting the end and continuing
	// is what you want, not a dead button.
	const step = (delta: number) => {
		if (blocks.length === 0) return;
		const from = activeBlock ?? (delta > 0 ? -1 : 0);
		onNavigate((from + delta + blocks.length) % blocks.length);
	};

	return (
		<Bar>
			{hasMarkers ? (
				<Navigator
					position={activeBlock}
					total={blocks.length}
					onPrev={() => step(-1)}
					onNext={() => step(1)}
				/>
			) : (
				<span style={{ color: "var(--success)", fontWeight: 500 }}>
					No conflict markers left
				</span>
			)}

			{hasMarkers && (
				<>
					<Divider />
					{/* The dot reinforces the side's colour; the words carry the
					    meaning, so the two are never told apart by colour alone. */}
					<Button
						disabled={busy}
						label="Accept all current"
						onClick={() => onAcceptAll("current")}
					>
						<Dot color="var(--success)" />
						All current
					</Button>
					<Button
						disabled={busy}
						label="Accept all incoming"
						onClick={() => onAcceptAll("incoming")}
					>
						<Dot color="var(--accent)" />
						All incoming
					</Button>
				</>
			)}

			<Divider />
			<Button
				disabled={busy}
				onClick={onToggleMergeView}
				pressed={mergeViewOpen}
			>
				Merge view
			</Button>
			{mergeViewOpen && conflictHasBase && (
				<Button disabled={busy} onClick={onToggleBase}>
					Base
				</Button>
			)}

			<div className="flex-1" />

			{isDirty && (
				<span style={{ color: "var(--fg-secondary)", fontSize: 11 }}>
					unsaved
				</span>
			)}

			{/* Enabled whenever the path is unmerged — deliberately NOT gated on
			 *  zero remaining blocks. Git lets you stage a file with markers still
			 *  in it, and Abundio should not be stricter than git without a reason
			 *  it can state. */}
			<Button primary disabled={busy} onClick={() => run(onResolveAndStage)}>
				{busy ? "Staging…" : "Resolve & stage"}
			</Button>
			{error && <Err>{error}</Err>}
		</Bar>
	);
}

/**
 * Position-and-total in one control: `‹ 2/5 ›`.
 *
 * The total doubles as the remaining count, so accepting a block visibly
 * shrinks it — one number instead of two competing ones in a 30px bar. The
 * counter is monospace and fixed-width so the arrows do not shift as digits
 * change.
 */
function Navigator({
	position,
	total,
	onPrev,
	onNext,
}: {
	position: number | null;
	total: number;
	onPrev: () => void;
	onNext: () => void;
}) {
	return (
		<div
			className="flex items-center flex-shrink-0 rounded overflow-hidden"
			style={{ border: "1px solid var(--border)", height: 20 }}
		>
			<Arrow label="Previous conflict" onClick={onPrev} glyph="\u2039" />
			<span
				className="flex items-center justify-center tabular-nums"
				style={{
					minWidth: 46,
					height: "100%",
					padding: "0 6px",
					fontSize: 11,
					fontFamily: "var(--font-mono)",
					color: "var(--warning)",
					backgroundColor:
						"color-mix(in srgb, var(--warning) 12%, transparent)",
					borderLeft: "1px solid var(--border)",
					borderRight: "1px solid var(--border)",
				}}
				title={`${total} conflict${total === 1 ? "" : "s"} remaining`}
			>
				{position === null ? "—" : position + 1}/{total}
			</span>
			<Arrow label="Next conflict" onClick={onNext} glyph="\u203a" />
		</div>
	);
}

function Arrow({
	label,
	onClick,
	glyph,
}: {
	label: string;
	onClick: () => void;
	glyph: string;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={onClick}
			className="flex items-center justify-center transition-colors"
			style={{
				width: 20,
				height: "100%",
				border: "none",
				background: "transparent",
				color: "var(--fg-secondary)",
				cursor: "pointer",
				fontSize: 13,
				lineHeight: 1,
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
				e.currentTarget.style.color = "var(--fg-primary)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.backgroundColor = "transparent";
				e.currentTarget.style.color = "var(--fg-secondary)";
			}}
		>
			{glyph}
		</button>
	);
}

/** Ties an "Accept all" button to the side colour used by the rails. */
function Dot({ color }: { color: string }) {
	return (
		<span
			className="inline-block rounded-full"
			style={{
				width: 6,
				height: 6,
				marginRight: 5,
				flexShrink: 0,
				backgroundColor: color,
			}}
		/>
	);
}

function Divider() {
	return (
		<span
			className="flex-shrink-0"
			style={{
				width: 1,
				height: 14,
				backgroundColor: "var(--border)",
				opacity: 0.7,
			}}
		/>
	);
}

function Bar({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="flex items-center gap-2 px-3"
			style={{
				flexShrink: 0,
				height: 30,
				fontSize: 11,
				fontFamily: "var(--font-ui)",
				borderBottom: "1px solid var(--border)",
				backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)",
			}}
		>
			{children}
		</div>
	);
}

function Button({
	children,
	onClick,
	disabled,
	primary,
	pressed,
	label,
}: {
	children: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
	primary?: boolean;
	pressed?: boolean;
	/** Full phrase for assistive tech when the visible text is abbreviated. */
	label?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-pressed={pressed}
			aria-label={label}
			title={label}
			className="rounded px-2 flex items-center flex-shrink-0 transition-colors"
			style={{
				height: 20,
				fontSize: 11,
				fontFamily: "var(--font-ui)",
				border: `1px solid ${pressed ? "var(--accent)" : "var(--border)"}`,
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.5 : 1,
				whiteSpace: "nowrap",
				color: primary ? "var(--bg-primary)" : "var(--fg-primary)",
				backgroundColor: primary
					? "var(--accent)"
					: pressed
						? "color-mix(in srgb, var(--accent) 18%, transparent)"
						: "var(--bg-tertiary)",
				transitionDuration: "var(--transition-fast)",
			}}
		>
			{children}
		</button>
	);
}

function Err({ children }: { children: React.ReactNode }) {
	return (
		<span
			style={{ color: "var(--error)", fontSize: 11 }}
			title={String(children)}
		>
			Failed
		</span>
	);
}
