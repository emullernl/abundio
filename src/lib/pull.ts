/**
 * Check for **Incoming commits** and **Pull** them (ADR-0066). Every way in —
 * the sidebar chip, the status bar, the Commits section, the Command palette —
 * goes through here, so the busy-Agent confirmation and the refusal dialog
 * are the same everywhere.
 */
import { detectWorkForWorkspace } from "../hooks/useConfirmCloseWorkspace";
import { useIncomingStore } from "../stores/incomingStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { pullOutcomeNotice } from "./incomingCommits";
import { git } from "./ipc";
import type { PullOutcome } from "./types";

function folderOf(workspaceId: string): string | null {
	return (
		useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
			?.rootFolder ?? null
	);
}

/** Fetch the Workspace's Upstream. Quiet: a failure is only remembered for
 *  the tooltip. The fresh counts arrive with the next scheduler bundle.
 *  `background` (the timer, window focus) leaves a repository nobody has
 *  fetched in yet alone (ADR-0066). */
export async function checkIncoming(
	workspaceId: string,
	opts: { background?: boolean } = {},
): Promise<void> {
	const cwd = folderOf(workspaceId);
	const store = useIncomingStore.getState();
	if (!cwd || store.checking.has(workspaceId)) return;
	store.startCheck(workspaceId);
	let error: string | null = null;
	try {
		const outcome = await git.fetchUpstream(cwd, opts.background ?? false);
		if (outcome.kind === "failed") error = outcome.message;
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	useIncomingStore.getState().endCheck(workspaceId, error);
}

/** Pull, asking first when an Agent in the Workspace is Working. */
export async function pullWorkspace(
	workspaceId: string,
	opts: { confirmed?: boolean } = {},
): Promise<void> {
	const store = useIncomingStore.getState();
	if (store.pulling.has(workspaceId)) return;
	if (!opts.confirmed && detectWorkForWorkspace(workspaceId).hasWorkingAgent) {
		store.setDialog({ kind: "confirmBusy", workspaceId });
		return;
	}
	const cwd = folderOf(workspaceId);
	if (!cwd) return;
	store.setPulling(workspaceId, true);
	store.startCheck(workspaceId);
	let outcome: PullOutcome;
	try {
		outcome = await git.pullFf(cwd);
	} catch (e) {
		outcome = {
			kind: "failed",
			message: e instanceof Error ? e.message : String(e),
		};
	}
	// Pulling first: a check that ends while a Pull runs leaves `checking`
	// set (see `endCheck`), so this one must be the Pull's own.
	const after = useIncomingStore.getState();
	after.setPulling(workspaceId, false);
	after.endCheck(
		workspaceId,
		outcome.kind === "fetchFailed" ? outcome.message : null,
	);
	if (pullOutcomeNotice(outcome)) {
		after.setDialog({ kind: "outcome", workspaceId, outcome });
	}
}
