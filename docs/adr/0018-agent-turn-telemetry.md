# Agent Turn telemetry & git-delta code attribution

We record agent activity to answer "how long did agents work and how much code did they produce, per day/month/year" via a **Statistics overlay**. The design choices below are surprising enough — and costly enough to reverse, since they shape a persisted schema — to record here. Full plan: `docs/plans/agent-turn-telemetry-and-statistics-overlay.md`.

## What we decided

- **The atomic unit is a Turn** (one prompt → turn-finished cycle), one row in the `agent_turn` table, grouped into **Sessions** by a `session_id`. We picked the Turn over the Session because it matches the glossary's existing "turn", gives per-prompt code attribution, and makes session-span / per-day / per-month / per-year all simple SQL `GROUP BY`s. (We retired the word "run" — it collides with the **Working** state's avoided "running".)

- **Code attribution is a git-diff net-vs-base delta**, not per-agent hook-payload parsing. We snapshot the Workspace's additions/deletions vs the base branch at Turn start and end and store the difference. This is **agent-agnostic** (works identically for all six agents and reuses the existing libgit2 compute) at the cost of being **approximate**: commits/manual edits/reverts during a Turn shift it. (Brand-new files an Agent creates *are* counted from creation, before `git add` — the untracked-files path counts each new file's lines as additions, matching `git diff --numstat`.) We chose approximate-but-universal over precise-but-per-agent for v1; precise per-agent counts (parsing `PostToolUse` payloads) can be layered on later without a schema change, preferred when present.

- **Concurrent Turns in one Workspace are unmeasured (NULL), not double-counted.** Git stats are per-Workspace, so two Turns running in the same Workspace at once would both claim the same delta. When that overlap is detected the line counts are stored as `NULL`; the raw start/end git snapshots are kept for possible re-derivation. (Worktree sets make same-Workspace concurrency uncommon — parallel agents usually live in separate worktree Workspaces.)

- **Viewing is Profile-scoped.** The overlay counts only the Window's **Active profile**'s Turns, even though it's launched from the otherwise-global **Overview bar** (see ADR-0005). Every Turn stores `profile_id` directly so this survives Workspace deletion.

- **Deletion lifetime is deliberately asymmetric.** `profile_id` is a `NOT NULL` FK with `ON DELETE CASCADE` — deleting a Profile wipes its Turns (they're unviewable under Profile-scope anyway, and it's the clean privacy story). `workspace_id` is a plain non-FK column — deleting a Workspace must **not** retroactively shrink monthly/yearly totals, so its Turns survive (labelled by a denormalized `workspace_name`). This intentionally departs from the Note-style "child dies with its Workspace" cascade.

- **Correlation lives in the frontend** (`agentTurnTracker.ts`), driven by the `ptyActivityStore` subscription plus the existing hook listener / PTY-exit handlers, because the Turn boundary, the ptyId→Workspace mapping, and the cached git totals all already live there. Rust just persists (`record_agent_turn`) and aggregates (`agent_turn_buckets` / `_totals`). Open Turns are finalized at end only; a crash/hard-quit leaves them open and they're closed by an orphan-recovery sweep on next launch.

## Known limitations

Line counts can be momentarily stale (the git scheduler push is coalesced; we do one explicit `fetchBundle` at finalize to mitigate). A dropped turn-finished hook leaves a Turn open until the 30s idle backstop or PTY exit. Day buckets use `localtime`, so they shift around midnight/DST. All acceptable for a personal-productivity view; the precise-attribution follow-up removes the git-delta-specific ones.
