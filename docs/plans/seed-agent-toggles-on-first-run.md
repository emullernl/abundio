# Seed Agent toggles from $PATH on first run

Implements ADR-0037. One branch, ordered commits — not split into separate PRs.

Vocabulary is fixed by CONTEXT.md: **Installed** (on `$PATH`, live, the green *Detected* badge), **Watched** (the per-Agent toggle, persisted as `enabled`), **Agent seeding** (the one-time act). The word "detection" now refers only to the runtime title/process match that flips a PTY into agent mode.

## 1. Rust: is this a new install?

`migrations.rs::open_db` already runs `import_legacy_state_if_needed()` before `Connection::open`, so the file's absence at that instant is exactly "new user".

- Add `fn db_was_absent_at_startup() -> bool`, memoised in a `OnceLock<bool>` set on the **first** `open_db` call (it is called two or three times at startup; later calls must not observe the file the first one created).
- Test: absent → true; a second call after the file exists → still true.

## 2. Rust: the one-time claim

Uses the existing app-global `settings` key-value table (`workspace_store.rs:764`) — no migration needed. Key: `agents_seeded`.

- `WorkspaceStore::claim_agent_seeding() -> Result<bool, AbundioError>`: inside a single transaction, return `false` if the key exists; otherwise write it and return `true`. Must be atomic — two Windows can call it at once.
- `WorkspaceStore::mark_agent_seeding_done()` for the existing-install path (idempotent).
- In `lib.rs` setup, after the store is built: if `!db_was_absent_at_startup()` and the key is absent, mark it done.
- `#[tauri::command] agents_claim_seeding` in `commands.rs`, returning `Result<bool, AbundioError>`.
- Tests: a fresh in-memory store claims once and only once; marking done makes the claim return false.

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
- Only if the claim returns `true`, apply `seedWatchedFromInstalled` to `settingsStore.agents`, then re-provision hooks the way `toggleAgent` does (`agentHooks.provision(agentHooksEnabled, provisionableAgentIds(...))`) — `provisionStartup` has already run for all nine by then, and an Agent seeded off that happens to have a stale config dir must lose its entries.
- Order is load-bearing: **scan → claim → seed**. Never claim first.
- No gating of the launch menus. For the few seconds before the seed lands the pickers list all nine; they then settle.

## 5. Settings ▸ Agents

- Add a *Match toggles to installed agents* button. It calls `reload()` then applies the same `seedWatchedFromInstalled`, then refreshes hook statuses. No confirm dialog; every effect is one toggle-flip away from undone.
- When the rescan finds nothing Installed, the button changes nothing and says so inline rather than switching everything off.
- Reword the section copy: the toggle is no longer described as "detection". Something like "Choose which agents Abundio watches for — enable or disable each, or add your own." The green *Detected* badge keeps its meaning (Installed) and is the only place that word appears.

## 6. Demo mode

`src/lib/demo/mockInvoke` must answer `agents_claim_seeding` (return `false` — the demo should never seed, its fixture agent set is curated).

## 7. Checks

`pnpm test`, `pnpm check`, `cd src-tauri && cargo test`. Per the project note, run the TS tooling via `npx --no-install`.

Verify in the real app, not just tests: launch with the data dir moved aside to simulate a new install and confirm the toggles land on the Installed set and hooks match; then relaunch and confirm nothing is re-seeded.
