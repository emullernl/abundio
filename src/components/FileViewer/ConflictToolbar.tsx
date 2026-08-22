import { useEffect, useState } from "react";
import type { ConflictBlock, ResolveChoice } from "../../lib/conflictMarkers";
import { fs, type GitConflictFile, git } from "../../lib/ipc";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { ChevronLeft, ChevronRight } from "../Icons";
import "./ConflictToolbar.css";

/** `.git/index` is deliberately excluded from the file watcher (read-only git
 *  commands touch it constantly), so the Rust scheduler never observes a
 *  staging write — every stage must refresh the tab itself. */
async function refreshGitChanges(cwd: string) {
	const store = useGitChangesStore.getState();
	await store.fetchChanges(cwd, store.baseBranch);
}

/** Beyond this the segments would be thinner than a pixel gap, so the track
 *  degrades to the bare counter. Arrows keep working either way. */
const MAX_SEGMENTS = 14;

/** Role colours, shared with the merge side panes' gutter rails so the mapping
 *  from colour to side is learned once and holds everywhere. */
const SIDE_COLOR = {
	current: "var(--success)",
	incoming: "var(--accent)",
} as const;

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

	// A pane is reused when a different file is opened into it, so this component
	// stays mounted with a new path. Without this it would keep claiming the new
	// file was staged, with no way back to the actions.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetting *on* a path change is the point
	useEffect(() => {
		setStaged(false);
		setError(null);
	}, [relativePath]);

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
		const verb =
			operation === "cherry_pick" ? "cherry-pick" : (operation ?? "merge");
		return (
			<Bar>
				<span className="abundio-ctb__done">Staged.</span>
				<span className="abundio-ctb__label">
					Finish the {operation ?? "merge"} with
				</span>
				<code className="abundio-ctb__code">git {verb} --continue</code>
			</Bar>
		);
	}

	// Binary: choosing a side means writing a blob to the worktree, which is a
	// bigger write than "save the buffer, git add". Out of scope by design.
	if (!hasMarkers && conflict?.isBinary) {
		return (
			<Bar>
				<span className="abundio-ctb__label">
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
				<span>
					This file was changed on one side of the merge and deleted on the
					other.
				</span>
				<span className="abundio-ctb__spacer" />
				<button
					type="button"
					className="abundio-ctb__ghost"
					disabled={busy}
					onClick={() => run(async () => await onResolveAndStage())}
				>
					Keep the file
				</button>
				<button
					type="button"
					className="abundio-ctb__ghost"
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
				</button>
				{error && <Err message={error} />}
			</Bar>
		);
	}

	// Wrap around: with a handful of conflicts, hitting the end and continuing is
	// what you want, not a dead button.
	const step = (delta: number) => {
		if (blocks.length === 0) return;
		const from = activeBlock ?? (delta > 0 ? -1 : 0);
		onNavigate((from + delta + blocks.length) % blocks.length);
	};

	return (
		<Bar>
			{hasMarkers ? (
				<Track
					position={activeBlock}
					total={blocks.length}
					onPrev={() => step(-1)}
					onNext={() => step(1)}
					onJump={onNavigate}
				/>
			) : (
				<span className="abundio-ctb__done">No conflict markers left</span>
			)}

			{hasMarkers && (
				<>
					<span className="abundio-ctb__divider" />
					<span className="abundio-ctb__label">Accept all</span>
					<button
						type="button"
						className="abundio-ctb__ghost"
						aria-label="Accept all current"
						title="Accept all current"
						disabled={busy}
						onClick={() => onAcceptAll("current")}
					>
						<span
							className="abundio-ctb__flag"
							style={{ backgroundColor: SIDE_COLOR.current }}
						/>
						current
					</button>
					<button
						type="button"
						className="abundio-ctb__ghost"
						aria-label="Accept all incoming"
						title="Accept all incoming"
						disabled={busy}
						onClick={() => onAcceptAll("incoming")}
					>
						<span
							className="abundio-ctb__flag"
							style={{ backgroundColor: SIDE_COLOR.incoming }}
						/>
						incoming
					</button>
				</>
			)}

			<span className="abundio-ctb__divider" />
			{/* A recessed well with a raised active chip: state, not an action. */}
			{/* biome-ignore lint/a11y/useSemanticElements: a fieldset carries form
			    semantics and default chrome that make no sense in a 30px toolbar;
			    role="group" is the idiomatic pairing for a segmented control */}
			<div
				className="abundio-ctb__well"
				role="group"
				aria-label="Merge view options"
			>
				<button
					type="button"
					className="abundio-ctb__toggle"
					aria-pressed={mergeViewOpen}
					disabled={busy}
					onClick={onToggleMergeView}
				>
					Merge view
				</button>
				<button
					type="button"
					className="abundio-ctb__toggle"
					aria-pressed={false}
					disabled={busy || !mergeViewOpen || !conflictHasBase}
					title={
						conflictHasBase
							? "Show the common ancestor"
							: "This conflict has no common ancestor"
					}
					onClick={onToggleBase}
				>
					Base
				</button>
			</div>

			<span className="abundio-ctb__spacer" />

			{isDirty && <span className="abundio-ctb__dirty">unsaved</span>}

			{/* Enabled whenever the path is unmerged — deliberately NOT gated on
			 *  zero remaining blocks. Git lets you stage a file with markers still
			 *  in it, and Abundio should not be stricter than git without a reason
			 *  it can state. */}
			<button
				type="button"
				className="abundio-ctb__primary"
				disabled={busy}
				onClick={() => run(onResolveAndStage)}
			>
				{busy ? "Staging…" : "Resolve & stage"}
			</button>
			{error && <Err message={error} />}
		</Bar>
	);
}

/**
 * Position, progress and navigation in one control.
 *
 * One segment per conflict, the current one lit and taller. How many are left
 * is read from the track's length rather than from a number, and any conflict
 * is one click away — which a bare `‹ 2/5 ›` counter cannot offer.
 */
function Track({
	position,
	total,
	onPrev,
	onNext,
	onJump,
}: {
	position: number | null;
	total: number;
	onPrev: () => void;
	onNext: () => void;
	onJump: (index: number) => void;
}) {
	return (
		<div className="abundio-ctb__nav">
			<button
				type="button"
				className="abundio-ctb__arrow"
				title="Previous conflict"
				aria-label="Previous conflict"
				onClick={onPrev}
			>
				<ChevronLeft size={12} />
			</button>

			{total <= MAX_SEGMENTS && (
				// biome-ignore lint/a11y/useSemanticElements: see the toolbar group above
				<div
					className="abundio-ctb__track"
					role="group"
					aria-label="Conflicts in this file"
				>
					{Array.from({ length: total }, (_, i) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: position *is* the identity
							key={i}
							type="button"
							className={`abundio-ctb__seg${
								i === position ? " abundio-ctb__seg--current" : ""
							}`}
							aria-label={`Go to conflict ${i + 1}`}
							aria-current={i === position}
							onClick={() => onJump(i)}
						/>
					))}
				</div>
			)}

			<span
				className="abundio-ctb__count"
				title={`${total} conflict${total === 1 ? "" : "s"} remaining`}
			>
				{position === null ? "—" : position + 1}/{total}
			</span>

			<button
				type="button"
				className="abundio-ctb__arrow"
				title="Next conflict"
				aria-label="Next conflict"
				onClick={onNext}
			>
				<ChevronRight size={12} />
			</button>
		</div>
	);
}

function Bar({ children }: { children: React.ReactNode }) {
	return <div className="abundio-ctb">{children}</div>;
}

/** The captured message is the only thing the user can act on when the one
 *  write path in the feature fails, so it must not be swallowed. */
function Err({ message }: { message: string }) {
	return (
		<span className="abundio-ctb__error" title={message}>
			Failed — {message}
		</span>
	);
}
