# Seed Agent toggles from $PATH on first run

Implements ADR-0037. One branch, ordered commits — not split into separate PRs.

Vocabulary is fixed by CONTEXT.md: **Installed** (on `$PATH`, live, the green *Detected* badge), **Watched** (the per-Agent toggle, persisted as `enabled`), **Agent seeding** (the one-time act). The word "detection" now refers only to the runtime title/process match that flips a PTY into agent mode.

## 1. Rust: is this a new install?

`migrations.rs::open_db` already runs `import_legacy_state_if_needed()` before `Connection::open`, so the file's absence at that instant is exactly "new user".

- `sample_db_absence(&Path)` is the pure half, tested against a tempdir. `open_db` keeps only the `OnceLock::set`, so the memoisation — process-global, settable once, and so poisonous to a test binary — stays out of the tests.
- `db_was_absent_at_startup()` `debug_assert`s that sampling has happened. Its `false` default is read by its caller as "existing install", which would silently disable seeding for every new install; the assert turns a misplaced call into a test failure instead.

## 2. Rust: the one-time claim

Uses the existing app-global `settings` key-value table (`workspace_store.rs:764`) — no migration needed. Two keys: `agents_seeded` (the claim, spent) and `agents_seeding_pending` (this install was created by an earlier launch and still owes a seed).

- `seeding_startup_action(db_was_absent, seeded, pending) -> SeedingStartupAction` is pure and holds the whole decision. **The file's existence alone cannot decide it**: that is true on every launch after the first, so a new install whose first scan came back empty would have its claim spent unseeded on launch 2.
- `mark_agent_seeding_pending()` / `mark_agent_seeding_done()` (the latter also clears pending) / `agent_seeding_is_done()` / `agent_seeding_is_pending()`.
- `agents_claim_seeding` writes **nothing durable**: mutual exclusion between Windows is a process-local `AtomicBool` (a Tauri app is one process), so a seed that never completes leaves the claim intact. `agents_commit_seeding` spends it afterwards.
- In `lib.rs` setup, apply `seeding_startup_action` to the store.
- Tests: the three-state truth table, the pending round-trip, commit clearing pending, idempotence.

## 3. Frontend: the seeding rule

New module `src/lib/agentSeeding.ts` with a pure function, so it is testable and shared by the first run and the button:

```ts
seedWatchedFromInstalled(agents: CodingAgent[], installed: Set<string>): CodingAgent[]
```

- Built-ins only: `enabled = installed.has(agent.command)`. Custom agents pass through untouched.
- Returns the input array unchanged when `installed` is empty (empty scan = failed scan), so callers can compare by identity.
- Tests: built-ins flip both ways; custom agents never move; empty set is a no-op; the returned array is a new object only when something changed.

## 4. Frontend: wire the first run

In `App.tsx`, where the startup scan already lives (`useAgentRegistryStore.getState().load(commands)`):

- `await` the scan, then **if** it found at least one Installed Agent, call `agents_claim_seeding()`.
- Only if the claim returns `true`, apply `seedWatchedFromInstalled` to `settingsStore.agents`, re-provision hooks the way `toggleAgent` does, then call `agents_commit_seeding()`.
- Order is load-bearing: **scan → claim → seed → commit**. Never claim first, and never commit before the seed has landed.
- No gating of the launch menus. For the few seconds before the seed lands the pickers list all nine; they then settle.

`agentRegistryStore` keeps the commands alongside the in-flight scan, so a caller joins it only when that scan covers what the caller asked about; otherwise it queues a fresh scan behind it.

## 5. Settings ▸ Agents

- Add a *Match toggles to installed agents* button. It calls `reload()` then applies the same `seedWatchedFromInstalled`, then refreshes hook statuses. No confirm dialog; every effect is one toggle-flip away from undone.
- When the rescan finds nothing Installed, the button changes nothing and says so inline rather than switching everything off. A *thrown* failure gets its own generic line — the PATH wording stays attached to the one thing that actually means a PATH problem — and the hook-footprint refresh runs outside the `try`, so a failure there can't report a match that did happen as one that didn't.
- Reword the section copy: the toggle is no longer described as "detection". Something like "Choose which agents Abundio watches for — enable or disable each, or add your own." The green *Detected* badge keeps its meaning (Installed) and is the only place that word appears.

## 6. Demo mode

`src/lib/demo/mockInvoke` must answer `agents_claim_seeding` (return `false` — the demo should never seed, its fixture agent set is curated) and `agents_commit_seeding`.

## 7. Checks

`pnpm test`, `pnpm check`, `cd src-tauri && cargo test`. Per the project note, run the TS tooling via `npx --no-install`.

Verify in the real app, not just tests: launch with the data dir moved aside to simulate a new install and confirm the toggles land on the Installed set and hooks match; then relaunch and confirm nothing is re-seeded.
