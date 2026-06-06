# Hook provisioning lifecycle: startup re-register, on-launch ensure, per-agent visibility

## Context

Abundio's **Hook provisioning** (the edits Abundio writes into each Agent's own config so the
Agent emits its **Agent hooks** back to Abundio — see `CONTEXT.md` and ADR-0003) currently runs
only when the **Status Hooks setting** is toggled. Two gaps follow from that:

1. **Startup re-registration is implicit and per-Window.** It *does* happen — `settingsStore.ts`'s
   `onRehydrateStorage` (`src/stores/settingsStore.ts:491-497`) calls `agentHooks.provision(true)`
   on every launch when `agentHooksEnabled` is persisted — but it runs **once per Window**, each
   with its own JS context, so N Windows write the same global config files N times. Rust startup
   only refreshes the relay *scripts* (`lib.rs:550` → `agent_hooks::refresh_relay_scripts`), not the
   config entries.
2. **A supported Agent installed mid-session gets no hooks until restart.** `provision()` only
   touches an Agent whose config dir already exists, and provisioning never re-runs until the next
   launch. So installing e.g. Gemini while Abundio is open, then launching it, yields no status dot
   until the app restarts (the next rehydrate `provision` picks it up).
3. **The system modifications are invisible per-Agent.** Settings shows a single global toggle
   (`SettingsPanel.tsx:1838-1877`) + a paragraph. There is no per-Agent view of *which* files
   Abundio touched or whether registration actually succeeded.

This plan makes provisioning lifecycle-aware (startup + on-launch, not just on-toggle) and adds a
read-only per-Agent **Provisioning footprint** to Settings. It builds on the existing provisioning
machinery in `src-tauri/src/agent_hooks.rs` and the status pipeline from
`agent-hooks-status-integration.md`.

## Decisions (resolved via grilling)

1. **Startup provisioning becomes Rust-owned and runs once per process.** A Rust `AtomicBool`
   guard makes the actual provisioning run a single time however many Windows open; the 2nd..Nth
   Window's calls are no-ops — eliminating the per-Window redundant writes. The enabled flag stays
   in frontend `localStorage` and is pushed to Rust (mirroring the updater's auto-check pattern).
   **No Rust-side settings persistence and no migration** are introduced.
2. **The toggle path is unchanged** — `setAgentHooksEnabled` keeps calling the always-run
   `provision`.
3. **On-launch check-and-register via one targeted Rust command.** New IPC
   `ensure_agent_hooks(agentId)` inspects *just that Agent's* config for the relay marker and, when
   missing (and hooks enabled), registers **only that Agent**. `provision()` is refactored into a
   per-agent helper that both the toggle (loop over all) and `ensure` (one agent) reuse.
4. **Wired into both launch paths.** The LaunchPicker path (`useSplitPane.ts` `splitPaneWithChoice`)
   **awaits** `ensure` before the command is typed, so hooks fire the **current** session. The
   manual-typed path (`terminalManager.ts` `command_start` → `matchTitleToAgent`) calls it
   best-effort — the process has already read its config, so it only takes effect on the **next**
   run. A per-session frontend cache avoids repeat `ensure` calls for the same Agent.
5. **The launch path may create a missing config dir; startup never does.** Most CLIs create their
   config dir only on first run, so to give a freshly-installed Agent hooks on its *first* run,
   `ensure_agent_hooks` creates the Agent's config dir + minimal config if absent. Launch is
   explicit intent. **Startup keeps the no-litter guard** (only provision Agents whose dir exists).
   This relaxes ADR-0003's litter rule for the launch case only — see the ADR-0003 "Revisited"
   amendment.
6. **Per-agent visibility is live, not static.** A new Rust `agent_hook_status` IPC inspects each
   Agent's actual config. Each Agent reads as **Registered / Not registered / Not installed /
   Not supported / Config error**.
7. **UI: expandable detail on each `AgentRow`.** A status badge on the row; a chevron expands to the
   config path, ownership (merged vs Abundio-owned), and hooked events, plus a **Reveal config
   file** link. **Read-only** — no per-agent register/unregister (registration is automatic; the
   global toggle is the only enable/disable control). When the global toggle is **off**, rows show a
   muted "Hooks off" and the *intended* footprint rather than alarming "Not registered" badges.
   Re-inspects (and re-scans installed Agents) when the Agents settings section opens.
8. **Out of hook support:** Aider and custom (non-builtin) Agents have no known hook format →
   *Not supported*; `ensure` is a no-op for them.

Canonical terms added to `CONTEXT.md`: **Hook provisioning**, **Status Hooks setting**,
**Provisioning footprint**. Lifecycle recorded in ADR-0003's "Revisited 2026-06-05" section.

## Backend (`src-tauri`)

### `agent_hooks.rs` — refactor + new inspection/ensure surface

- **Extract a per-agent helper** from `provision()`'s existing per-agent blocks
  (`agent_hooks.rs:412-482`):

  ```rust
  /// Provision (or strip) a single agent. `create_dir` lets the launch path
  /// scaffold a missing config dir; startup/toggle pass false (no-litter).
  fn provision_agent(
      home: &Path,
      relay: &RelayPaths,
      agent_id: &str,
      enabled: bool,
      create_dir: bool,
  ) -> Result<(), AbundioError>
  ```

  Map `agent_id` → (config dir, mechanism): `claude`/`gemini`/`qwen` → merge into `settings.json`;
  `codex` → owned `hooks.json`; `copilot` → owned `hooks/abundio.json`; `opencode` → owned
  `plugin/abundio.ts`. Unknown ids (incl. `aider`, custom) → `Ok(())` no-op. The existing
  `dir.is_dir()` guard moves inside, conditioned on `!create_dir`; when `create_dir`, `fs::create_dir_all`
  the config dir first. `provision(enabled)` becomes a loop calling `provision_agent(.., create_dir=false)`
  for each supported agent, preserving today's curl check and per-agent error accumulation.

- **`is_provisioned(home, relay, agent_id) -> bool`** — merge agents: parse `settings.json`, true if
  any `hooks` group is `group_is_abundio(..)` (reuse `agent_hooks.rs:169`). Owned-file agents: the
  Abundio file exists *and* contains the current relay path (so a stale relay path reads as
  not-registered and gets refreshed).

- **`agent_hook_status() -> Vec<AgentHookStatus>`** — for each supported agent return:

  ```rust
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  struct AgentHookStatus {
      agent_id: String,
      supported: bool,        // false for aider/custom
      config_path: String,    // ~/.claude/settings.json, etc.
      ownership: Ownership,   // Merged | Owned
      events: Vec<String>,    // hooked lifecycle events
      state: HookState,       // Registered | NotRegistered | NotInstalled | NotSupported | ConfigError
  }
  ```

  `NotInstalled` = config dir absent (combine with the frontend `$PATH` scan — see below — to
  distinguish "binary off PATH" from "installed but never run"). `ConfigError` = `settings.json`
  unparseable (today `provision_merge_settings` aborts on this — surface it instead of swallowing).

- **`ensure_agent_hooks(home, relay, agent_id, enabled) -> bool`** — if `enabled && supported &&
  !is_provisioned(..)`, call `provision_agent(.., create_dir=true)` and return `true` (provisioned);
  else `false`. Reuses `is_provisioned` (the same inspection backing `agent_hook_status`).

- **Tests** (extend the existing `#[cfg(test)]` module): `provision_agent` adds-then-strips a single
  agent idempotently; `ensure` creates a missing dir and writes a marker; `ensure` is a no-op when
  already provisioned and for `aider`/unknown ids; `agent_hook_status` classifies registered /
  not-registered / config-error / not-installed correctly.

### `commands.rs` — new handlers

- `agent_hooks_provision_startup(enabled, state: State<StartupGuard>)` — wraps
  `agent_hooks::provision(enabled)` behind the once-guard (below); subsequent calls return `Ok(())`
  immediately. Keep the existing `agent_hooks_provision` (`commands.rs:461-465`) for the toggle.
- `ensure_agent_hooks(agent_id: String, enabled: bool) -> Result<bool, _>` — resolves home + relay
  paths, calls `agent_hooks::ensure_agent_hooks`. `spawn_blocking` like the existing command.
- `agent_hook_status() -> Result<Vec<AgentHookStatus>, _>`.
- All three registered in the `invoke_handler` list (`lib.rs:923`).

### `lib.rs` — startup guard state

- Add `struct StartupGuard(AtomicBool)` and `app.manage(StartupGuard(AtomicBool::new(false)))` in
  `setup()`. The relay-script refresh at `lib.rs:550` stays as-is (scripts are inert no-ops and
  refreshing them is independent of the enabled flag).

## Frontend (`src/`)

- **`lib/ipc.ts`** — extend the `agentHooks` wrapper (`ipc.ts:440-442`): `provisionStartup(enabled)`,
  `ensure(agentId)`, `status()`.
- **`stores/settingsStore.ts`** — `onRehydrateStorage` (`:493-497`) calls
  `agentHooks.provisionStartup(true)` instead of `provision(true)`. Toggle (`:339`) unchanged.
- **`hooks/useSplitPane.ts`** — in `splitPaneWithChoice` (`:57-61`), before `setPendingAgent`:
  `if (agent && useSettingsStore.getState().agentHooksEnabled) await agentHooks.ensure(agent.id);`
  (wrap in try/catch — a provisioning failure must not block the launch).
- **`lib/terminalManager.ts`** — at the `matchTitleToAgent` hit (`:862-866`), fire-and-forget
  `agentHooks.ensure(matched.id)` when `agentHooksEnabled`, guarded by a module-level
  `Set<agentId>` so it runs at most once per agent per session.
- **`stores/agentRegistryStore.ts`** — add `reload(commands)` that bypasses the `loaded`/`loading`
  guard (`:17`) so the Agents settings section can refresh the "Installed" badge.
- **`components/SettingsPanel.tsx`** —
  - In the `agents` section (`:1835`), fetch `agentHooks.status()` on mount/section-open into local
    state, plus `agentRegistry.reload(...)`.
  - Extend `AgentRow` (`:632`): add a status badge (driven by the matched `AgentHookStatus` +
    `installed` from the registry scan) and a chevron toggling an expanded detail panel (config path,
    `merged`/`Abundio-owned`, the events list, and a **Reveal config file** button →
    new `reveal_path` IPC or `tauri-plugin-opener`/shell `open`). When `agentHooksEnabled` is false,
    render the muted "Hooks off" treatment and the intended footprint.
  - **Build the UI via the `frontend-design` skill.**
- **`lib/demo/mockInvoke.ts`** — stub `agent_hooks_provision_startup`, `ensure_agent_hooks`,
  `agent_hook_status` (`mockInvoke.ts:186` is the existing `agent_hooks_provision` case) so demo mode
  renders the footprint without touching the filesystem.

## Edge cases & non-goals

- **First-ever run of a never-configured Agent** now gets hooks via launch-path dir creation; a
  *manually-typed* first run still won't (config already read) — covered next launch.
- **Custom / Aider Agents** surface as *Not supported* and are never written.
- **`NotInstalled` vs installed-but-unprovisioned** — distinguished by combining the `$PATH` scan
  (`list_installed_agent_commands`) with the config inspection.
- **Multi-window startup** — the once-guard means exactly one provisioning pass per process
  regardless of Window count; `localStorage` isolation per webview is fine since the first window's
  enabled value is authoritative for the startup pass.
- **No per-agent enable/disable** — provisioning stays all-or-nothing under the global toggle; the
  per-agent surface is read-only.

## Test checklist

- Rust: per-agent provision/strip idempotency; `ensure` creates-dir + writes marker; `ensure`
  no-ops when provisioned / for unsupported ids; `agent_hook_status` classification.
- Frontend: `splitPaneWithChoice` awaits `ensure` only when hooks enabled; `command_start` ensure
  fires once per agent per session; `AgentRow` renders each of the five states incl. the toggle-off
  treatment.
- `pnpm test`, `pnpm check`, `cd src-tauri && cargo test` before considering complete.
