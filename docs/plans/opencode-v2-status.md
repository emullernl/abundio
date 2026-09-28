# OpenCode 2.x Status Support

## Context

A user on OpenCode 2.0.18 reported `Server plugin error … Plugin must export a default
definition with an id and an effect or setup function` for
`~/.config/opencode/plugin/abundio.ts`. That file is the 1.x-shaped plugin Abundio writes
(`agent_hooks.rs` `opencode_plugin()`). The 2.x loader requires
`export default { id, setup }`, so it skips the file, and OpenCode panes get no status.

Fixing the shape alone is not enough, and the user's hand-made fix (a 2.x-shaped server
plugin in `plugins/abundio.ts`) only *loads*. Findings from the 2.0.18 binary and the
`@opencode/plugin` / `@opencode/client` 2.0.18 type files:

- **2.x has a full lifecycle stream.** The claim in
  `opencode-event-vocabulary.md` that it has none was wrong. Relevant events, all with the
  data under `event.data`: `session.execution.started|succeeded|failed|interrupted`,
  `session.idle`, `session.status`, `permission.asked|replied`,
  `form.created|replied|cancelled` (the agent asks the user a question),
  `session.retry.scheduled`, `session.created` (`data.parentID`), `session.deleted`.
- **All TUIs share one background server** (`opencode serve --service`, port 49374,
  `~/.local/state/opencode/service.json`). Server plugins run inside it, so
  `process.env.ABUNDIO_*` there belongs to the server, not the pane. See ADR-0045.
- **TUI plugins run in the pane's own process.** The context (`dist/tui/context.d.ts`)
  offers `data.on(type, fn)` / `data.listen(fn)`, `app.router.current()` →
  `{type:"session", sessionID}`, `data.session.root(id)` / `family(id)`, and
  `data.session.status(id)` → `"idle" | "running"`.
- **A 2.x plugin can be a folder** with `server` / `index`, `tui` and `rpc` entries. The
  TUI loads plugins of source `local` or `package` that have a `tui` entry.
- **Bare imports do not resolve** for plugins OpenCode finds by itself on disk (the
  report's layer 2). The plugin must be an import-free plain object.
- The 1.x loader (1.18.21) rejects any export that is not a function or `{ server }`
  ("Plugin export is not a function"). So one file cannot serve both versions.

## Decisions (locked with the user via grilling, 2026-09-28)

| # | Decision | Rationale |
|---|----------|-----------|
| Routing | **A TUI plugin**, not a server plugin, not `--standalone`, and Abundio does not read the server's event stream. | ADR-0045. |
| Versions | **Support 1.x and 2.x**, each with its own plugin. | Users are on both lines. The 1.x vocabulary fix is already planned. |
| Detection | **`opencode --version`**, run in `agent_hooks` (not `agent_registry`, which stays subprocess-free). Cached per resolved binary path and mtime. | Works for every install method (npm, brew, curl installer, bun). Guessing from the install layout doesn't. An upgrade is picked up at the next launch, through `ensure_agent_hooks`. |
| Location | **Abundio owns the folder `~/.config/opencode/plugins/abundio/`** (`tui.ts`). Owned-file rule: counts as registered only if the content matches exactly. | No edits to the user's `cli.json`. **Fallback** if the probe shows local folders are not found automatically: merge the plugin path into the `plugins` array of `cli.json`, following the merge-and-strip rules used for `~/.claude/settings.json`. |
| Cleanup | On 2.x, **delete `plugin/abundio.ts` only if it is Abundio's**, i.e. it carries the "auto-generated, do not edit" header. Leave hand-made files and `.bak` files alone. On 1.x, remove the 2.x folder. | The leftover 1.x file is what raises the user-visible error. Abundio deletes only what it wrote. |
| Plugin id | `abundio.status-tui`. Must not clash with the id `abundio.status` from the report's hand port. | Two plugins with the same id could shadow each other. |
| Split of work | **The plugin classifies, the frontend maps.** The plugin drops events from other TUIs' sessions, tags the rest `self` or `child`, and forwards the raw 2.x event name. | Only the TUI knows which session is on screen. The name→status table stays in `agentHookMap.ts`, where Vitest can test it. Putting translation into a JS string in Rust is how four made-up 1.x event names got through. |
| Agent id | **Same `opencode`**, with `&v=2` in the hook URL. The translator picks the 2.x table. | One Agent in Settings, stats and turn tracking, continuous across an upgrade. |
| Session followed | **The session on screen**: `root(router.current().sessionID)`. On change: send a session reset, then seed the starting state from `data.session.status(id)`. **Home screen: drop events.** Never adopt a session that starts running elsewhere, because on the shared server it may belong to another pane. | The status icon describes what the user is looking at. |
| Child asks | A Subagent's `permission.asked` / `form.created` → the **pane goes Waiting**. The replies → Working. Other child events are Subagent start/stop signals only. | The user must act either way. This deliberately relaxes, for 2.x, the rule that a child event is a Subagent signal or nothing. |

## The 2.x mapping

Events tagged `self`:

```ts
// agentHookMap.ts — OpenCode 2.x table, selected when the hook carries v=2
"session.execution.started":     "active",        // also the Turn start
"permission.asked":              "waiting",
"form.created":                  "waiting",
"permission.replied":            "active",
"form.replied":                  "active",
"form.cancelled":                "active",
"session.execution.succeeded":   "ready",
"session.execution.failed":      "error",
"session.execution.interrupted": "idle",
"session.retry.scheduled":       "resume",
"session.deleted":               "sessionReset",
// session.idle, session.status: unmapped — execution.* already reports the outcome
```

Events tagged `child`: `session.execution.started` → Subagent started (id =
`data.sessionID`); `session.execution.succeeded|failed|interrupted` and `session.deleted`
→ Subagent stopped; `permission.asked` / `form.created` → the pane goes Waiting;
`permission.replied` / `form.*` replies → Working (resume). Everything else is dropped.

`TURN_START_EVENTS.opencode` for 2.x = `session.execution.started` (self only). On 2.x
the start of a Turn is observed, not guessed from token output.

## Probe protocol (run first — gates the design)

A throwaway TUI plugin, `~/.config/opencode/plugins/abundio-probe/tui.ts`, logs the
**shape** of each event (type, session id, `root()` of that id, current route), never
its content, to an ndjson file. Then drive a real Abundio pane. In this order:

1. **The TUI sees the pane's environment and events.** Does `process.env.ABUNDIO_*`
   reach the TUI plugin? Does `data.on` deliver `execution.*`, `permission.*` and
   `form.*` for the session on screen? *Fail → B is dead; go back to ADR-0045's
   rejected options.*
2. **Local folder plugins are found automatically.** Does `plugins/abundio-probe/tui.ts`
   load with no `cli.json` entry? *Fail → merge into `cli.json`.*
3. **Children are tagged correctly.** When a Subagent's events arrive, does `root()` of
   its session already equal the parent? Does a child's `permission.asked` arrive at the
   parent's TUI? *Fail → exclusion using `session.created`'s `data.parentID`.*
4. **`--version` is fast and has no side effects** on 2.x and 1.x: how long it takes,
   the output format, it doesn't start the background service, and it tolerates a log
   file it can't write. *Fail → detect from the install layout, with `--version` as the
   fallback.*
5. Also record: does `session.execution.interrupted` carry `reason: "user"` on Esc? Do
   other TUIs' sessions reach this TUI at all?

Record the captured log in this document before writing the 2.x table.

## Regression guard

Add `@opencode/client` 2.x as a devDependency, next to the 1.x `@opencode-ai/sdk`
guard. A Vitest case asserts that every key in the 2.x table is a member of the
`V2Event["type"]` union.

## Commits (one branch: `feat/opencode-v2-status`)

1. `docs:` the 1.x vocabulary plan (cherry-picked) and this plan, ADR-0045, CONTEXT.md.
2–6. The 1.x vocabulary commits, as listed in `opencode-event-vocabulary.md`.
7. `test:` `@opencode/client` devDependency and the 2.x event-name guard. Red.
8. `feat:` detect the OpenCode major version in `agent_hooks` (cached `--version`).
9. `feat:` the 2.x TUI plugin as an owned folder. Version-aware
   `agent_descriptor` / `owned_content` / `config_state`. Delete the owned 1.x file on 2.x
   and the folder on 1.x. Settings ▸ Agents shows the path that is actually used.
10. `feat:` the 2.x table and the child-ask handling in `agentHookMap` and the translator.
    Pick the table by `v=2`. Turns the guard green.
11. `docs:` the probe log in this plan, and ADR-0022 amended for the 2.x child-ask
    exception.

## Out of scope

- Reporting the "bare imports don't resolve for plugins OpenCode finds by itself" gap
  upstream.
- 2.x shared-server features beyond status (showing a turn still running in the
  background after a session switch).
