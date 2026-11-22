/**
 * What the PR panel says about Workspaces on a Host. Pull requests are
 * polled on this computer, with its own `gh` account, so only this
 * computer's repositories are tracked: a Host's `gh` may be another
 * account, whose PRs this panel would never show. Pure.
 */
import type { PrScope } from "../stores/prStore";

export interface PrHostFacts {
	/** The Host the Active workspace is on; `null`: this computer. */
	activeHostName: string | null;
	/** The Host this whole Window (a Remote profile) is on. */
	remoteHostName: string | null;
	/** The Profile's Workspace list has Workspaces on a Host. */
	profileHasHostWorkspaces: boolean;
}

/** `block`: shown instead of the list; `note`: a line above it. */
export function prHostNote(
	scope: PrScope,
	f: PrHostFacts,
): { block: string | null; note: string | null } {
	const why =
		"Pull requests are tracked only for repositories on this computer.";
	if (scope === "repo" && f.activeHostName) {
		return {
			block: `This Workspace is on ${f.activeHostName}. ${why}`,
			note: null,
		};
	}
	if (scope === "profile" && f.remoteHostName) {
		return {
			block: `This profile is on ${f.remoteHostName}. ${why}`,
			note: null,
		};
	}
	if (scope === "profile" && f.profileHasHostWorkspaces) {
		return { block: null, note: "Workspaces on Hosts are not included." };
	}
	return { block: null, note: null };
}

/** The Workspaces whose repositories the PR panel tracks: this computer's. */
export function trackedWorkspaces<T extends { joined?: { hostId: string } }>(
	workspaces: readonly T[],
	remoteWindow: boolean,
): T[] {
	return remoteWindow ? [] : workspaces.filter((w) => !w.joined);
}
