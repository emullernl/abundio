# PR views are Profile-scoped by default

The **Pull Requests** section offered two scopes over the poller's one account-wide dataset: **All**
(every PR on the GitHub account) and **Repo** (the **Active workspace**'s repository). With several
unrelated bodies of work on one GitHub account, neither is the useful default — All is other
people's noise, Repo forgets the four sibling repos you are also working in today. The unit the
user actually thinks in already exists: the **Profile**.

So there is now a third scope, **Profile**: PRs whose repository is one that the Active profile's
Workspaces resolve to. It is the default for both sub-sections, and existing installs are migrated
onto it once (`abundio-pr-panel` persist `version: 1`) — an explicit `-all` left in localStorage
from before would otherwise beat the new default forever. Anything the user picks afterwards
stands. The key lives in per-webview localStorage, so each **Window** migrates independently, which
is correct: each Window has its own Active profile.

**Repository identity comes from the Workspace list, not from a stored field.** A Workspace stores
only its folder; the mapping to `owner/repo` is derived live by libgit2, exactly like **Worktree
set** membership (ADR-0017). It rides the existing batch `git_workspaces_summary` — already run
across the whole profile whenever the workspace list changes — rather than a second command: the
repository is already open there for the worktree bits, so all this adds is a config read. Two
consequences fall out of deriving rather than storing: several Workspaces in one **Worktree set**
collapse to a single repository, and a Workspace can contribute *several* repositories, because we
keep **every** GitHub remote rather than just `origin`. That last part is not tidiness — in a fork
checkout (`origin` = your fork, `upstream` = the base repo) GitHub reports your PR against the base
repo, so an origin-only rule would hide your own PRs in precisely the workflow that most needs
them.

**An empty repository set yields an empty list, not the full one.** The Repo scope falls back to
the account-wide list when it has no slug, and copying that would have been easy — but "this
profile matched nothing" is a real answer and the panel says so ("No GitHub repositories in this
profile"). Silently widening to every PR on the account is the exact failure this scope exists to
avoid. The set is asynchronous, so the panel distinguishes *not yet resolved* ("Loading
repositories…") from *genuinely none*; without that flag the honest message would spend the first
few hundred milliseconds of every launch being a lie.

**The Overview bar chips follow the profile too — reversing ADR-0005.** That ADR fixed the chips as
account-wide, and required the panel to fetch an extra `-all` variant so a repo-scoped panel
couldn't drag the chip with it. The reasoning was that the bar is *global* chrome; the counter-case
is that a per-Window number the user cannot act on from that Window is not glanceable, it is
noise — the same argument that made the **Statistics overlay** Profile-scoped despite launching
from the same bar (ADR-0018). The chips are pinned to the Profile scope *regardless* of either
dropdown: they must mean one thing, and the two sub-sections have independent dropdowns, so
"whatever the panel is showing" would silently redefine the number.

**The counts are derived on read, never stored.** `globalReviewCount` / `globalMyPrsCount` were
fields written in `applyPrState`. A Profile-scoped count depends on two independently-changing
inputs — the poller payload *and* the repository set — and a cached total drifts whenever one moves
without the other (adding a Workspace between polls). `profilePrCounts` runs the same `visiblePrs`
rule the section runs, so the chip and the section it summarises cannot disagree. This is ADR-0020's
"derive live, no cached totals" applied to a second surface.

**Notifications stay account-wide.** Tempting to filter them the same way, and rejected: Rust emits
`pr-changes` to exactly *one* Window (ADR-0019), so client-side profile filtering would not reroute
a notification to the Window whose profile owns that repo — it would drop it. Until the poller
learns which Window holds which Profile, a notification you did not want beats a notification you
never get. Recorded as a flagged ambiguity in `CONTEXT.md` so the asymmetry reads as chosen.

**The empty-Opened-set rule changed shape.** Previously, with zero **Opened workspaces** both
sections force-showed `-all` and the dropdown was locked, because there was no repo to filter to.
Profile scope does not need anything Opened — it reads the **Left sidebar**'s Workspace list — so
the lock is gone: a stored `-repo` preference degrades to `-profile` (the next-narrowest scope,
rather than jumping to the noisiest one), Repo is simply absent from the dropdown while there is
nothing to point it at, and the stored preference is restored untouched when a workspace reopens.

Supersedes in part: ADR-0005 (chips are no longer account-wide), ADR-0019 (All-vs-Repo is now
All-vs-Profile-vs-Repo, defaulting to Profile).
