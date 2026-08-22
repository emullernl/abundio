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
}: Props) {
	const [staged, setStaged] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<GitConflictFile | null>(null);
	const operation = useGitChangesStore((s) => s.operationInProgress);

	const hasMarkers = blocks.length > 0;

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

	return (
		<Bar>
			<span
				style={{
					color: hasMarkers ? "var(--warning)" : "var(--success)",
					fontWeight: 500,
				}}
			>
				{hasMarkers
					? `${blocks.length} conflict${blocks.length === 1 ? "" : "s"} remaining`
					: "No conflict markers left"}
			</span>

			{hasMarkers && (
				<>
					<Button disabled={busy} onClick={() => onAcceptAll("current")}>
						Accept all current
					</Button>
					<Button disabled={busy} onClick={() => onAcceptAll("incoming")}>
						Accept all incoming
					</Button>
				</>
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
}: {
	children: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
	primary?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="rounded px-2 py-0.5 transition-colors"
			style={{
				fontSize: 11,
				fontFamily: "var(--font-ui)",
				border: "1px solid var(--border)",
				cursor: disabled ? "default" : "pointer",
				opacity: disabled ? 0.5 : 1,
				color: primary ? "var(--bg-primary)" : "var(--fg-primary)",
				backgroundColor: primary ? "var(--accent)" : "var(--bg-tertiary)",
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
