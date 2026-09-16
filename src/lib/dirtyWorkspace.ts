import type { GitChangedFile } from "./types";

/** Distinct paths per uncommitted **Section** — the Dirty marker's tooltip. */
export type UncommittedBreakdown = {
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
};

/** Whether a Workspace is a **Dirty workspace**, and how.
 *
 *  `breakdown` is non-null only while the value is **live** — derived from a
 *  scheduler bundle (or the active workspace's fetch). The batched summary only
 *  knows yes/no, so its entries carry `breakdown: null`, and the store uses that
 *  to keep a slower batch from overwriting a fresher live answer. */
export type Uncommitted = {
	dirty: boolean;
	breakdown: UncommittedBreakdown | null;
};

/** The **Branch stat**: how big the branch is against its base, including
 *  uncommitted work. */
export type BranchStat = {
	changedFileCount: number;
	additions: number;
	deletions: number;
};

function distinctPathCount(files: GitChangedFile[]): number {
	return new Set(files.map((f) => f.path)).size;
}

/** Dirtiness from a changed-file list. `against_base` is committed history and
 *  never makes a Workspace dirty. */
export function uncommittedOf(files: GitChangedFile[]): Uncommitted {
	const inSection = (section: GitChangedFile["section"]) =>
		distinctPathCount(files.filter((f) => f.section === section));
	const breakdown: UncommittedBreakdown = {
		staged: inSection("staged"),
		unstaged: inSection("unstaged"),
		untracked: inSection("untracked"),
		conflicted: inSection("conflicted"),
	};
	const dirty =
		breakdown.staged +
			breakdown.unstaged +
			breakdown.untracked +
			breakdown.conflicted >
		0;
	return { dirty, breakdown };
}

/** The Branch stat from a changed-file list. A file listed in several Sections
 *  (committed on the branch *and* edited again) is one file; line counts are
 *  summed, since each Section compares a different pair of endpoints. */
export function branchStatOf(files: GitChangedFile[]): BranchStat {
	return {
		changedFileCount: distinctPathCount(files),
		additions: files.reduce((s, f) => s + f.additions, 0),
		deletions: files.reduce((s, f) => s + f.deletions, 0),
	};
}

export function uncommittedEqual(a: Uncommitted, b: Uncommitted): boolean {
	if (a.dirty !== b.dirty) return false;
	if (a.breakdown === null || b.breakdown === null) {
		return a.breakdown === b.breakdown;
	}
	return (
		a.breakdown.staged === b.breakdown.staged &&
		a.breakdown.unstaged === b.breakdown.unstaged &&
		a.breakdown.untracked === b.breakdown.untracked &&
		a.breakdown.conflicted === b.breakdown.conflicted
	);
}

/** Tooltip for a Dirty marker. Only a live value can say *what* is uncommitted. */
export function uncommittedTooltip(u: Uncommitted): string {
	const b = u.breakdown;
	if (!b) return "Uncommitted changes";
	const parts: string[] = [];
	if (b.staged > 0) parts.push(`${b.staged} staged`);
	if (b.unstaged > 0) parts.push(`${b.unstaged} unstaged`);
	if (b.untracked > 0) parts.push(`${b.untracked} untracked`);
	if (b.conflicted > 0) parts.push(`${b.conflicted} conflicted`);
	return parts.length > 0
		? `Uncommitted: ${parts.join(" · ")}`
		: "Uncommitted changes";
}

/** Tooltip for the Branch stat — names the base it is measured against, so it
 *  is never read as "uncommitted changes". */
export function branchStatTooltip(
	stat: BranchStat,
	baseBranch: string | null | undefined,
): string {
	const base = baseBranch || "the default branch";
	const files = `${stat.changedFileCount} file${stat.changedFileCount === 1 ? "" : "s"}`;
	return `vs ${base}: ${files}, +${stat.additions} −${stat.deletions}, including uncommitted`;
}
