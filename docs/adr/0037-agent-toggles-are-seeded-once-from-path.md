---
status: accepted
---

# Agent toggles are seeded once from $PATH, then owned by the user

On a genuinely new install, each built-in **Agent**'s **Watched** toggle starts on only if that Agent is **Installed** — its command resolves on the user's login-shell `$PATH`. After that one moment nothing but the user ever moves the toggle again. Installing an Agent later does not switch it on; uninstalling one does not switch it off.

See the **Agent**, **Installed**, **Watched** and **Agent seeding** entries in CONTEXT.md.

## Why not just derive the toggle from what is installed

Because the two facts answer different questions, and welding them makes one of them unanswerable.

**Installed** is a fact about the machine that Abundio reads and stores no opinion about. **Watched** is a decision: offer this Agent in the launch menus, match it against terminal titles and process names, provision its **Agent hooks**. A user who runs three Agents but only wants Abundio watching one is expressing something the machine cannot tell us, and a derived toggle has nowhere to put it.

The failure modes are also lopsided. `shell_env::shell_path()` gets the real `$PATH` by running the user's login+interactive shell — the only way to see Agents that add themselves from `.zshrc` — and gives up after five seconds, falling back to the app's own minimal `PATH` plus the two Homebrew dirs. A derived toggle turns every such timeout into "your Agents disappeared", repeatedly, at startup. A seeded toggle can get that wrong exactly once, in the one session where the user has configured nothing to lose.

Rejected for the same reason: seeding once *and* auto-enabling newly-installed Agents later. It needs a third per-Agent fact ("has the user touched this?"), and it re-introduces the surprise it was meant to avoid, just less often.

## An empty scan is a failed scan

If the scan reports **zero** Installed Agents, seeding does not run and the claim is not taken, so the next launch tries again. A developer running a terminal multiplexer built around AI coding CLIs, with none of the nine installed, is possible; a shell that timed out is likelier. And the two errors do not cost the same: over-detecting leaves a menu entry that fails loudly with "command not found", while under-detecting leaves an Agent that silently never gets detected in a pane and never gets hooks.

The same guard covers the manual *Match toggles to installed agents* action, which otherwise turns a slow shell into "the button switched everything off".

## Scan, claim, seed, commit — in that order

The one-time-ness lives in the app-global `settings` table, not in localStorage: localStorage is per-WKWebView on macOS, so every **Window** keeps its own copy and each would seed independently — and, because windows broadcast their own store changes, a second Window's seed would overwrite toggles the user had set in the first. Same reasoning that put `last_seen_version` in that table (ADR-0036).

Each step is placed where a failure costs nothing:

- **Claim after the scan returns something.** Claiming up front and then declining to seed would spend the only chance on a shell timeout.
- **Commit after the seed lands.** The claim itself writes nothing durable — mutual exclusion between Windows is a process-local flag, which is sufficient because a Tauri app is one process. `agents_seeded` is written only once the toggles are actually set. An exception on the way, or a quit before zustand persists `abundio-settings`, therefore leaves the claim intact rather than spending it on a seed that never happened.

## Telling an upgrade from an install that hasn't seeded yet

An upgrade must not move switches a user is relying on, and switching an Agent off also removes its hooks. So an existing install has `agents_seeded` written without anything being seeded.

**The database file's existence cannot decide this on its own.** It is true on every launch after the first, not just for upgrades — so a new install whose first scan came back empty (or that was quit inside the five seconds `shell_path()` can take) would have its claim spent unseeded on the *second* launch, reaching silently the exact state this decision set out to avoid.

So a launch that finds no database records `agents_seeding_pending`, and startup reads three facts:

| `agents_seeded` | db was absent | `agents_seeding_pending` | action |
|---|---|---|---|
| set | — | — | nothing; already decided |
| — | yes | — | mark pending: this launch created the install |
| — | no | yes | nothing: an earlier launch created it and still owes a seed, so the claim survives to retry |
| — | no | no | mark done: this database predates the feature — the upgrade path |

"The database was absent" is sampled in `open_db`, which runs the previous-epoch import (ADR-0025) *before* `Connection::open`; a returning user's file is in place by the time we look. Memoised in a `OnceLock` because `open_db` is called more than once during startup — by the second call the file exists regardless.

The cost of the upgrade path is accepted: current users keep all nine built-ins switched on and only see the change if they press the button.

## A new built-in still arrives switched on

When a future release adds a tenth built-in, `mergeAgentsWithBuiltins` gives it `enabled: true` for everyone already seeded, and that stays. Seeding happens once, at install, with no exceptions — an extra row after an update is a smaller cost than a new Agent that silently never appears, and the alternative is the continuous derivation rejected above wearing a different hat.
