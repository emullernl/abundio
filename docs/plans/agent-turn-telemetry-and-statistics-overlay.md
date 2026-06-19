# Agent Turn Telemetry & Statistics Overlay

## Context

Abundio has first-class AI-agent support but keeps **no history** of agent work. The user wants, over time (per day / month / year), how long agents worked and how much code they produced — plus behavioral insight per agent.

Two things make this cheap to build:
1. **Turn boundaries are already detected.** The loopback hook server (`hook_server.rs`) emits `agent-hook-{ptyId}`; `terminalManager.ts` maps them via `agentHookMap.ts` to `ptyActivityStore` transitions (Working/Waiting/Ready/Error/clear). That gives precise **turn start/end timing** per agent, per PTY, for free.
2. **Line counts are already computed.** Every `GitChangedFile` carries `additions`/`deletions` (libgit2 `Patch::line_stats()`), cached per-workspace in `gitChangesStore`/`workspaceGitStore`. Nothing is persisted — we snapshot it.

This plan adds an `agent_turn` table, a frontend **Turn tracker** that records one row per Turn, Profile-scoped SQL aggregation commands, and a content-area **Statistics overlay** launched from the Overview bar.

### Decisions (locked with the user — earlier session + grilling against CONTEXT.md)

| # | Decision | Rationale |
|---|----------|-----------|
| Attribution | **Git-diff delta** ("net lines vs base"), agent-agnostic. Not per-agent hook-payload parsing. | Works for all 6 agents, reuses existing git compute. Approximate by design; precise parsing deferred. |
| 1 | **Atomic unit = Turn** (one prompt→Stop cycle), with a `session_id` grouping Turns of one agent process. | Matches the glossary's canonical "turn"; precise per-prompt attribution; session span + day/month/year are `GROUP BY`s. Resolves the original plan's turn-vs-session contradiction. |
| 2 | Canonical terms **Turn** / **Session**; "run/running" retired. | `running` is on **Working**'s _Avoid_ list. Table `agent_turn`, `agentTurnTracker.ts`, `telemetry_record_turn`. |
| 3 | **Profile-scoped** — overlay counts only the Window's **Active profile**. Every Turn stores `profile_id`. | User choice. Respects the hard Profile boundary. Overlay refetches on Profile switch. (Flag: global-chrome button opens Profile-scoped content.) |
| 4 | **Split lifetime**: Profile delete → Turns cascade-delete; Workspace delete → Turns **survive**. | Deleting a Profile = wipe body of work (and unviewable under Profile-scope anyway). Deleting a Workspace shouldn't shrink monthly totals. Deviates from Note-style cascade at the Workspace level → ADR. |
| 5 | Toggle **stays on the Overview bar**; amend its glossary entry + ADR-0005. | "read-only" redefined as "never mutates state"; a navigation affordance is allowed. |
| 6 | Surface = **Statistics overlay** (feature: **Statistics**). | "panel" retired; "view"/"screen" collide with Tab; "window"/"dashboard" taken. "overlay" is collision-free. |
| 7 | Columns **`working_ms` + `waiting_ms`** (+ `duration_ms`), not `active_ms`. | Aligns with canonical **Working**/**Waiting**; avoids the flagged `active`↔Active-workspace collision and the planned code rename. |
| 8 | **Null-out on overlap** — if another Turn is open in the same Workspace, that Turn's line counts are `NULL` (unattributed). | Git stats are per-Workspace; concurrent same-Workspace Turns would double-count. Keeps "lines this month" honest. Cheap (open-Turn map already exists). Worktree sets make this case uncommon anyway. |
| Metrics | All four groups: working-vs-wall-clock; prompts/permission/error rates; per-agent & per-workspace breakdown; activity heatmap & streaks. | All derive from the `agent_turn` row. |

---

## 0. Pre-flight (before ANY implementation)

1. **Persist this plan into the repo.** Copy this document to `docs/plans/agent-turn-telemetry-and-statistics-overlay.md` (create `docs/plans/` — it does not exist yet; it sits alongside `docs/adr/`). This is the first commit-able artifact and the canonical reference during implementation.
2. **Back up the SQLite database.** Before the new migration `012` can run (migrations auto-apply on the next `pnpm tauri dev` / app launch once registered), make a timestamped copy of the live DB and its WAL sidecars:
   ```bash
   DB="$HOME/Library/Application Support/abundio/abundio.db"
   TS=$(date +%Y%m%d-%H%M%S)
   for f in "$DB" "$DB-wal" "$DB-shm"; do [ -f "$f" ] && cp "$f" "$f.bak-$TS"; done
   ```
   Rationale: migration 012 is additive (a new `CREATE TABLE`, no table rebuild) so risk is low, but it auto-applies irreversibly on first launch and the framework has no down-migrations. A backup is the cheap escape hatch. Do this **before** the first launch that includes migration 012.

---

## 1. Data model — migration `012_add_agent_turns.sql`

One row per **Turn**. `profile_id` is a `NOT NULL` FK that **cascades** on Profile delete (matches existing `workspaces.profile_id`; runtime FK enforcement confirmed via `open_db()` `PRAGMA foreign_keys=ON` at `migrations.rs:509`). `workspace_id` is a plain non-FK column so Turns **survive Workspace deletion**; `workspace_path`/`workspace_name` are denormalized labels. Line counts are **nullable** (NULL = unattributed, e.g. concurrent-Turn overlap). Measured timestamps are **Unix ms** (the lifecycle is `Date.now()`-driven); `created_at` is `unixepoch()` seconds for row provenance.

```sql
CREATE TABLE agent_turn (
    id                        TEXT PRIMARY KEY,         -- uuid, minted frontend at turn start
    session_id                TEXT,                     -- groups turns of one agent process in a pty
    profile_id                TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    workspace_id              TEXT,                     -- nullable, NOT a FK (survives workspace delete)
    workspace_path            TEXT NOT NULL DEFAULT '',
    workspace_name            TEXT NOT NULL DEFAULT '',
    agent_id                  TEXT NOT NULL,            -- claude | copilot | gemini | ...
    pty_id                    TEXT NOT NULL DEFAULT '',
    started_at                INTEGER NOT NULL,         -- ms
    ended_at                  INTEGER,                  -- ms; NULL while open
    duration_ms               INTEGER,                  -- wall clock = ended_at - started_at
    working_ms                INTEGER,                  -- time in Working state
    waiting_ms                INTEGER,                  -- time in Waiting state (blocked on user)
    end_reason                TEXT,                     -- stop|error|session_end|pty_exit|app_quit|orphan_recovered
    permission_requests_count INTEGER NOT NULL DEFAULT 0,
    tool_calls_count          INTEGER NOT NULL DEFAULT 0, -- DROPPED in migration 013 (unmeasurable; removed from UI + CSV)
    error_count               INTEGER NOT NULL DEFAULT 0,
    lines_added               INTEGER,                  -- NULL = unattributed (overlap / unknown)
    lines_deleted             INTEGER,
    files_changed             INTEGER,
    git_added_start           INTEGER,                  -- raw snapshots (debug / re-derivation), kept even on overlap
    git_deleted_start         INTEGER,
    git_added_end             INTEGER,
    git_deleted_end           INTEGER,
    created_at                INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Primary dashboard query: WHERE profile_id=? AND started_at IN [from,to)
CREATE INDEX idx_agent_turn_profile_started   ON agent_turn (profile_id, started_at);
CREATE INDEX idx_agent_turn_agent_started     ON agent_turn (agent_id, started_at);
CREATE INDEX idx_agent_turn_workspace_started ON agent_turn (workspace_id, started_at);
CREATE INDEX idx_agent_turn_session           ON agent_turn (session_id);
CREATE INDEX idx_agent_turn_open              ON agent_turn (ended_at) WHERE ended_at IS NULL;
```

- Register in `migrations.rs` `MIGRATIONS` as `("012_add_agent_turns", include_str!(...))`; **bump `migrations_table_has_entries` 11 → 12.**
- No `prompts_count` (a Turn has exactly one prompt). No per-tool-call table in v1.

---

## 2. Turn tracker (frontend) — new `src/lib/agentTurnTracker.ts`

Pure, testable singleton holding `Map<ptyId, OpenTurn>` in module scope (mirrors `lastOutputTimestamps` in `ptyActivityStore.ts`). Correlation lives in the **frontend** because all inputs already do: Turn boundary (hook listener + activity store), `ptyId→workspace` (`panePtyMap` + `findPaneLocation`), `workspace→profile_id` (loaded workspace rows / Window's Active profile), cached git totals (`gitChangesStore`). Rust just persists.

**Session id:** minted when an Agent is first detected in a PTY (`setAgentPty` after a `clear`), reused for every Turn until `clearAgentPty`/`SessionEnd`/exit. Stamped on each Turn row.

**State machine:**
- **Turn START** — on a `Working` (active) transition when **no open Turn** exists for that ptyId → `beginTurn({ptyId, agentId, profileId, workspaceId, workspacePath, workspaceName, sessionId, gitStart})`, mint uuid, set `startedAt`, start working timer.
- **Resume** — `Working` while a Turn is open (e.g. after answering a permission prompt) → resume working timer; do **not** open a new Turn.
- **working_ms / waiting_ms** — accumulate on state changes: entering Working sets `workingSince`; leaving accrues to `working_ms`. Entering Waiting sets `waitingSince`; leaving accrues to `waiting_ms`. `duration_ms = ended_at - started_at`.
- **Counters** — `permission_requests_count`++ on `Waiting`; `tool_calls_count`++ on any hook event carrying a `toolName`; `error_count`++ on `Error`.
- **Turn END** — `endTurn(ptyId, reason, gitEnd)` on `Ready`→`stop`, `Error`→`error`, `clear`(SessionEnd)→`session_end`, PTY exit→`pty_exit`.
  - **Overlap null-out (#8):** if another open Turn exists with the same `workspace_id`, set `lines_added/deleted/files_changed = NULL` (still store raw `git_*`). Else `lines_added = max(0, gitEnd.added - gitStart.added)` etc. (headline floors at 0; raw columns keep signed values).

**Robustness seams:**
- Subscribe to `usePtyActivityStore` (like the notifier at `ptyActivityStore.ts:492`) so the idle-scanner backstop (`active→ready` with no hook) also closes the working stretch / finalizes.
- **Stale-git mitigation (R1):** on `endTurn` for a Turn that touched files, do one explicit `git.fetchBundle(cwd, baseBranch)` for `gitEnd` rather than the possibly-coalesced cached value.
- **App quit:** add `finalizeAllOpenTurns("app_quit")` to the quit path beside `saveAllSnapshots()`.
- **Orphan recovery:** startup `telemetry.recoverOrphans()` closes `ended_at IS NULL` rows (`ended_at = started_at`, `end_reason='orphan_recovered'`).

**Wiring** (`src/lib/terminalManager.ts`): the `pty.onHook` listener (~1049–1090) for start/transitions/counters/end; both `pty.onStatus` exit handlers (~357, ~1032) for `pty_exit`. Initialize tracker + store subscription once at the App root.

---

## 3. Backend CRUD + aggregation (Profile-scoped)

`WorkspaceStore` methods (`workspace_store.rs`, new `// ── Agent telemetry ──` section, in-memory-DB testable):
```rust
record_agent_turn(&self, t: &AgentTurnRecord) -> Result<(), AbundioError>          // INSERT OR REPLACE by id
agent_turn_buckets(&self, profile_id, from_ms, to_ms, bucket, group_by) -> Result<Vec<AgentTurnBucket>, _>
agent_turn_totals(&self, profile_id, from_ms, to_ms) -> Result<AgentTurnTotals, _>
list_agent_turns(&self, profile_id, from_ms, to_ms) -> Result<Vec<AgentTurnRecord>, _>
recover_orphan_turns(&self) -> Result<u32, _>
```

**Aggregate in SQL** (indexed `(profile_id, started_at)`). `started_at` ms → `/1000` for date fns; bucket via `strftime('%Y-%m-%d'|'%Y-%m'|'%Y', started_at/1000, 'unixepoch','localtime')`. `Bucket`/`GroupBy` enums pick the format and optional `, agent_id`/`, workspace_id` clause (built from a `match`, never interpolated). `SUM` ignores NULL line counts (overlap Turns contribute 0 to line totals but still count in `turn_count` — correct). Example (day, by agent):
```sql
SELECT strftime('%Y-%m-%d', started_at/1000,'unixepoch','localtime') AS bucket, agent_id,
       COUNT(*) AS turn_count,
       COALESCE(SUM(duration_ms),0) AS total_duration_ms,
       COALESCE(SUM(working_ms),0)  AS total_working_ms,
       COALESCE(SUM(waiting_ms),0)  AS total_waiting_ms,
       SUM(lines_added) AS total_lines_added, SUM(lines_deleted) AS total_lines_deleted,
       SUM(files_changed) AS total_files_changed,
       COALESCE(SUM(permission_requests_count),0) AS total_permission_requests,
       COALESCE(SUM(error_count),0) AS total_errors
FROM agent_turn
WHERE profile_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND ended_at IS NOT NULL
GROUP BY bucket, agent_id ORDER BY bucket ASC;
```

Tauri commands (`commands.rs`, registered in `lib.rs`), all `Result<_, AbundioError>`, all take `profileId` except record/recover: `telemetry_record_turn`, `telemetry_buckets`, `telemetry_totals`, `telemetry_list_turns`, `telemetry_recover_orphans`.

IPC (`src/lib/ipc.ts`) — `telemetry` export mirroring `notes`/`git`, with camelCase `AgentTurnRecord`/`AgentTurnBucket`/`AgentTurnTotals` and `TelemetryBucket`/`TelemetryGroupBy` (`"none"|"agent"|"workspace"` — no `profile`, since scoped). `src/stores/telemetryStore.ts` caches `{profileId, range, bucket, buckets, totals, loading}` and **refetches on Profile switch and range change**.

---

## 4. UI — Statistics overlay, launched from the Overview bar

**Toggle state** in `src/stores/windowUiStore.ts` (per-Window persisted, same place as `rightSidebarOpen`): add `statisticsOverlayOpen: boolean` + `toggleStatisticsOverlay()`/`setStatisticsOverlayOpen()`, include in `partialize`.

**Toggle button** in `src/components/OverviewBar.tsx`: after the last `</Section>` (~line 185) add a `marginLeft:auto` spacer + a right-aligned icon button reusing `TileShell` (44×24, Lucide `BarChart3`), wired to `toggleStatisticsOverlay`, `active` when open. (This is the navigation affordance that amends the Overview bar's read-only definition — §6.)

**Overlay mount** in `src/App.tsx` central column (`flex-1 min-w-0 flex flex-col relative`, ~line 700): render `<StatisticsOverlay />` **once per Window** as an absolutely-positioned surface `top: TITLEBAR_HEIGHT + OVERVIEW_BAR_HEIGHT; left/right/bottom:0`, z-index **below** the Overview bar's `z-40` (toggle stays clickable) but **above** the workspace stack, shown only when `statisticsOverlayOpen`. Sits inside the central column so it doesn't cover the **Right sidebar**. Header has the close button (`setStatisticsOverlayOpen(false)`). Content scoped to the Window's **Active profile**; refetch on Profile switch.

**Terminals stay alive** automatically — `TerminalPool` keeps every `TerminalInstance` mounted off-screen and projects via `portalRegistry`; covering the workspace stack neither unmounts nor kills any PTY. (Confirmed; no action.)

**Keybinding** (`src/lib/keybindings.ts`): add `toggle-statistics-overlay` on a free shortcut (verify availability; `Cmd+Shift+S` / `Ctrl+Alt+S` candidate) → `useWindowUiStore.getState().toggleStatisticsOverlay()`.

**Components** — new `src/components/Statistics/`. Invoke the **frontend-design** skill; **hand-roll SVG/CSS** charts (no charting dep; theme via `themes.ts` CSS vars):
```
StatisticsOverlay        // header (title + range controls + close); owns range+granularity; fetches via telemetry.*; scoped to Active profile
├── StatsRangeControls   // Day/Week/Month/Year/All + prev/next stepper
├── StatsSummaryCards    // working vs wall-clock time; net lines ± (caveat tooltip; "unknown" when NULL); files;
│   └── StatCard         //   turns + avg duration; permission-request rate; error rate; tool calls; top agent
├── StatsActivityChart   // SVG bars per bucket (working-time primary; toggle turns / lines)
├── StatsAgentBreakdown  // horizontal stacked bar per agent (reuse agentIcons.tsx)
├── StatsWorkspaceBreakdown // per-workspace leaderboard (deleted workspaces shown by denormalized name)
├── StatsHeatmap         // hour × day-of-week from started_at; + streaks strip (consecutive local-days with ≥1 Turn in this Profile) + busiest-day / longest-turn records
└── StatsTurnsTable      // drill-down: recent Turns (agent, workspace, duration, lines ±)
```

---

## 5. Documentation updates

- **CONTEXT.md — new canonical terms:** **Turn** (one unit of agent work, prompt-submit → turn-finished/failed; the atomic telemetry record), **Session** (the span of one Agent process in a Pane, launch→`SessionEnd`/exit, comprising one or more Turns; derived `session_id`), **Statistics overlay** (a per-Window, full-area surface over the **workspace stack**, scoped to the **Active profile**, launched from the **Overview bar**; terminals stay alive behind it).
- **CONTEXT.md — amend Overview bar entry:** "read-only" = *never mutates app/workspace state*; it carries one **navigation affordance** — the entry point to the **Statistics overlay**. Drop "dashboard (implies interactivity)" from _Avoid_ or rescope it.
- **CONTEXT.md — Flagged ambiguities:** note that the Statistics overlay is **Profile-scoped** even though launched from global Overview-bar chrome; and that Turn line counts are **net-vs-base** and `NULL` when concurrent same-Workspace Turns make attribution ambiguous.
- **ADR-0005** — append a note: the Overview bar gained the Statistics-overlay launch button.
- **ADR-0018 (new)** — "Agent Turn telemetry & git-delta code attribution": records unit=Turn(+session_id), Profile-scoped viewing, split deletion lifetime (cascade Profile / survive Workspace), git-diff net-vs-base attribution (chosen over precise per-agent hook parsing), and the concurrent-Turn null-out. Meets all three ADR criteria (hard to reverse, surprising to a future reader, real trade-off).

---

## 6. Testing

**Rust** (`#[cfg(test)]` in `workspace_store.rs`, in-memory DB + `run_migrations` + `PRAGMA foreign_keys=ON`):
- `migrations_table_has_entries` → 12; `agent_turn` table-exists.
- `record_agent_turn` inserts; same `id` replaces (idempotent). Recording with non-existent `workspace_id` succeeds (no FK). **Deleting a Profile cascade-deletes its Turns; deleting a Workspace leaves its Turns intact** (the #4 split — counterpart to `deleting_profile_cascades_to_workspaces`).
- `agent_turn_buckets`: seed across two days/months; correct day/month grouping, sums, `none`/`agent`/`workspace` variants; a Turn at local midnight to lock `localtime`; open Turns excluded; NULL line counts excluded from line sums but counted in `turn_count`. `agent_turn_totals` matches. Buckets filtered by `profile_id` (a second profile's Turns don't leak).
- `recover_orphan_turns` closes an open row; no-op on second call.

**Frontend** (`src/lib/__tests__/agentTurnTracker.test.ts`, Vitest + `vi.mock("../ipc")`):
- One `Working` opens one Turn; repeated `Working` doesn't double-open; `Waiting→Working` resumes.
- `working_ms`/`waiting_ms` accrue to the right states; `working_ms + waiting_ms ≤ duration_ms`.
- Counters: permissions on `Waiting`; tool calls on `toolName`; errors on `Error`.
- End reasons map (`stop`/`error`/`session_end`/`pty_exit`); `recordTurn` called once each.
- Git delta floors at 0, keeps raw `git_added_end`; **overlap null-out**: two open Turns same `workspace_id` → both finalize with `lines_*=NULL`, raw `git_*` retained.
- `session_id` shared across a session's Turns; new session after `clear`.
- `finalizeAllOpenTurns` flushes each once; idle-scanner `active→ready` finalizes via the subscription.

---

## 7. Verification (end-to-end)

1. `cd src-tauri && cargo test` (store/aggregation/migration/cascade) and `pnpm test -- agentTurnTracker`.
2. `pnpm tauri dev`; run a Claude Code session, let it edit files and finish. Confirm a row: `sqlite3 ~/Library/Application\ Support/abundio/abundio.db 'SELECT agent_id,duration_ms,working_ms,waiting_ms,lines_added,lines_deleted,session_id FROM agent_turn ORDER BY created_at DESC LIMIT 5;'`. Run a second prompt → second Turn, same `session_id`.
3. Click the OverviewBar button → Statistics overlay covers the workspace stack; terminals keep running behind (switch back, output intact). Close button hides it.
4. Verify working-vs-wall-clock split, net lines (caveat tooltip), per-agent/per-workspace breakdown, heatmap + streak. Switch Day→Month→Year. Switch **Profile** → numbers change to that Profile's. Run two agents in one Workspace concurrently → their line counts show "unknown". Quit mid-Turn, relaunch → open Turn recovered (closed), not stuck.

---

## Scope

**v1:** migration 012; `agentTurnTracker.ts` + wiring; backend CRUD/aggregation/commands/IPC/`telemetryStore`; OverviewBar toggle + per-Window `StatisticsOverlay` (Profile-scoped, all four metric groups, hand-rolled charts); overlap null-out; orphan recovery + quit flush; doc updates (CONTEXT.md terms + Overview-bar amend + ADR-0005 note + ADR-0018); tests.

**Later (additive, no schema break):** precise per-agent line counts via hook tool-payload parsing (prefer when present, fall back to git-delta — removes R1/overlap/untracked limits); per-language breakdown; commits-during-Turn; autonomy ratio; tokens/cost if a uniform signal appears.

## Risks
- **R1 (biggest):** git totals at Turn-end can be stale (coalesced scheduler) → explicit `fetchBundle` at finalize mitigates but can still race a slow fs-watcher. Net-vs-base is approximate by design.
- **R2:** dropped `Stop`/`SessionEnd` hooks leave Turns open until the 30s idle backstop or PTY exit; long hookless work can be backstopped early, undercounting `working_ms` (pre-existing activity-system behavior).
- **R3:** `localtime` day buckets shift around midnight/DST (acceptable for a personal dashboard; locked in tests).
- **R4:** untracked new files report `0/0` additions until tracked → net-vs-base undercounts brand-new files (fixed later by precise attribution).
- **R5 (mitigated):** concurrent same-Workspace Turns — resolved by null-out (#8); those Turns show "unknown" lines rather than double-counting.

## Critical files
- `src-tauri/migrations/012_add_agent_turns.sql` *(new)*, `src-tauri/src/migrations.rs` (register + bump to 12)
- `src-tauri/src/workspace_store.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- `src/lib/agentTurnTracker.ts` *(new)*, `src/lib/agentHookMap.ts` (add `isPromptSubmitEvent`/session helpers if needed), `src/lib/terminalManager.ts` (wiring), `src/lib/ipc.ts`
- `src/stores/telemetryStore.ts` *(new)*, `src/stores/windowUiStore.ts` (toggle state)
- `src/components/OverviewBar.tsx` (toggle button), `src/App.tsx` (mount overlay), `src/lib/keybindings.ts`
- `src/components/Statistics/*` *(new)*
- `CONTEXT.md`, `docs/adr/0005-overview-bar.md` (note), `docs/adr/0018-agent-turn-telemetry.md` *(new)*
