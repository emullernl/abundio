import { useEffect } from "react";
import { worktrees } from "../lib/ipc";
import { addWindowFocusListener } from "../lib/windowFocus";
import { distinctGroupKeys } from "../lib/worktreeGrouping";
import { useWorkspaceGitStore } from "../stores/workspaceGitStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

/** Least time between two focus-triggered Dirty-marker refreshes. Long enough
 *  that flicking between windows costs nothing, short enough that coming back to
 *  Abundio after real work elsewhere shows the truth. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 10_000;

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * Reconcile this Window's Workspace list for one repository against disk after
 * a CLI `git worktree add/remove`. Eager add (incl. standalone bootstrap) for
 * real on-disk worktrees; git-confirmed auto-remove (the worktree is no longer
 * tracked by git at all) — a folder that's merely missing but still tracked is
 * left as a stale entry. See ADR-0017.
 */
async function reconcileRepo(commonDir: string): Promise<void> {
	const store = useWorkspaceStore.getState();
	const facts = useWorkspaceGitStore.getState().worktreeFacts;
	const members = store.workspaces.filter(
		(w) => facts[w.id]?.worktreeGroupKey === commonDir,
	);
	// Empty here means this repo belongs to another Window's Profile — ignore.
	if (members.length === 0) return;

	// Probe the main worktree first, then linked ones, until one resolves — the
	// member we happen to list first could itself be the one whose folder just
	// vanished, which would make `list` throw and silently stall the sync.
	const probeOrder = [
		...members.filter((m) => facts[m.id]?.isMainWorktree),
		...members.filter((m) => !facts[m.id]?.isMainWorktree),
	];
	let onDisk: Awaited<ReturnType<typeof worktrees.list>> | null = null;
	for (const m of probeOrder) {
		try {
			onDisk = await worktrees.list(m.rootFolder);
			break;
		} catch {
			// Try the next member.
		}
	}
	// Can't enumerate from any member (whole repo vanished) — leave stale.
	if (!onDisk) return;

	// Eager add: every real worktree becomes a Workspace (addDiscoveredWorktree
	// dedups by folder, so existing ones and our own in-app adds are no-ops).
	for (const entry of onDisk) {
		if (entry.exists) {
			await store.addDiscoveredWorktree(basename(entry.path), entry.path);
		}
	}

	// Git-confirmed remove: a member whose folder git no longer tracks at all.
	// Compare against the member's *canonical* root (from the summary) so a
	// symlinked path — e.g. /tmp vs /private/tmp — never mismatches and deletes
	// a live workspace (the data-loss footgun ADR-0017 guards against).
	const trackedPaths = new Set(onDisk.map((e) => e.path));
	for (const m of members) {
		const canonical = facts[m.id]?.worktreeRoot ?? m.rootFolder;
		if (!trackedPaths.has(canonical) && !trackedPaths.has(m.rootFolder)) {
			await store.deleteWorkspace(m.id);
		}
	}
}

/**
 * Keeps Worktree set grouping in sync with the workspace list and the
 * filesystem. (1) Refreshes per-workspace grouping facts via one batched
 * summary and registers this Window's watched repo common dirs whenever the
 * workspace id/folder set changes; (2) reconciles on the Rust watcher's
 * `worktrees-changed` event for live CLI add/remove. See ADR-0017.
 */
export function useWorktreeSync(): void {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const signature = workspaces.map((w) => `${w.id}:${w.rootFolder}`).join("|");

	// `signature` is the intended trigger; the body reads fresh state via
	// getState() rather than the reactive value, so it's the only dep.
	// biome-ignore lint/correctness/useExhaustiveDependencies: signature is the re-run key
	useEffect(() => {
		let cancelled = false;
		const list = useWorkspaceStore.getState().workspaces.map((w) => ({
			id: w.id,
			rootFolder: w.rootFolder,
			baseBranch: w.baseBranch ?? null,
		}));
		if (list.length === 0) {
			worktrees.watchSet([]).catch(() => {});
			return;
		}
		useWorkspaceGitStore
			.getState()
			.syncWorktreeFacts(list)
			.then(() => {
				if (cancelled) return;
				const facts = useWorkspaceGitStore.getState().worktreeFacts;
				const keys = distinctGroupKeys(
					useWorkspaceStore.getState().workspaces,
					facts,
				);
				worktrees.watchSet(keys).catch(() => {});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [signature]);

	// Refresh unopened workspaces' Dirty markers when the Window regains focus.
	// Opened workspaces are live through their scheduler; an unopened one mostly
	// changes from outside Abundio, which the user returns from by focusing us.
	//
	// Restricted to workspaces with no live answer, because each summary is a
	// working-tree status walk: asking about the opened ones would scan the
	// repositories the user is actively working in — usually the largest — and
	// then throw the answer away (`uncommittedFromSummaries` keeps the live one).
	// Rate-limited for the same reason: `inFlight` stops overlap but not
	// repetition, and alt-tabbing back and forth would otherwise cost a scan per
	// repository per transition, in every open Window.
	useEffect(() => {
		let inFlight = false;
		let lastRefreshAt = 0;
		return addWindowFocusListener((focused) => {
			if (!focused || inFlight) return;
			if (Date.now() - lastRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
			const live = useWorkspaceGitStore.getState().uncommittedById;
			const list = useWorkspaceStore
				.getState()
				.workspaces.filter((w) => !live[w.id]?.breakdown)
				.map((w) => ({
					id: w.id,
					rootFolder: w.rootFolder,
					baseBranch: w.baseBranch ?? null,
				}));
			if (list.length === 0) return;
			lastRefreshAt = Date.now();
			inFlight = true;
			useWorkspaceGitStore
				.getState()
				.syncWorktreeFacts(list)
				.catch(() => {})
				.finally(() => {
					inFlight = false;
				});
		});
	}, []);

	// Live reconcile on CLI worktree add/remove. Registered once.
	useEffect(() => {
		const unlistenP = worktrees.onChanged((commonDir) => {
			reconcileRepo(commonDir).catch(() => {});
		});
		return () => {
			unlistenP.then((fn) => fn()).catch(() => {});
		};
	}, []);
}
