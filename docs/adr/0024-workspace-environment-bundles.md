---
status: accepted
---

# Workspace Environment Bundles: encrypted at rest, injected or on-demand

Projects keep `.env` and `.env.production` files in the repo for `docker compose`.
Commodity **infostealer** malware globs for exactly those paths — `**/.env`,
`~/.aws/credentials`, browser cookie databases — and exfiltrates them. Getting
those files off disk is an effective mitigation against that class, because such
malware rarely enumerates live processes to read `/proc/<pid>/environ` or
`KERN_PROCARGS2`.

**Decision:** a Workspace owns named **Environment Bundles**. At most one is
*injected* into every PTY's environment at spawn; the rest are *on-demand* and
enter a process environment only when `abundio-env run` puts them there. Values
are sealed with AES-256-GCM under a single master key in the OS credential store.

## Injection is visible, and can be turned off

Injection was originally always-on and invisible: nothing on screen said which
Bundle a terminal had been spawned with, which matters most in exactly the
workspace that has both a `dev` and a `production` Bundle. A green pill in the
status bar names the injected Bundle and its variable count, and is hidden when
that Bundle resolves to nothing — a pill claiming an environment that is not
there would be worse than no pill. It is **read-only**: the status bar reports
what is true, and acting on it belongs next to the Bundles being acted on.

**Zero injected Bundles is a legitimate state**, reached with the green
injection toggle beside the bundle row in workspace settings. That toggle is one
control in two states rather than separate *Inject* / *Turn off* buttons, and it
is the only place injection state is drawn in the dialog — a per-tab bolt badge
said the same thing twice, and left the current state to be inferred from which
button happened to be showing. The partial unique index enforces *at
most* one, never exactly one, so nothing invents a flag for a Workspace that has
opted out. Bundles stay saved and readable through `abundio-env`; only the
automatic injection stops, and running terminals keep the environment they were
spawned with until restarted.

"Off" is a **stored flag** on the Workspace (`env_injection_disabled`,
migration 014), not the absence of an `injected` row. It has to be, because of
inheritance: shadowing the parent's *currently* injected Bundle with a local
non-injected row — the first design — was undone the moment the main worktree
injected some other Bundle, silently handing an opted-out worktree the parent's
production secrets. The flag is checked before inheritance, cleared only by an
explicit *Inject*, and deliberately not cleared by creating a Bundle: creating
one is not choosing an environment.

Dropping `merged_bundles`' old "first bundle wins if nothing is flagged"
fallback also changed behaviour for Workspaces that never opted out, on existing
databases that migration 014 does not backfill. A linked worktree that added its
own Bundle while inheriting an injected parent holds rows with `injected = 0`
(`create_own_bundle`); if that parent later stops being resolvable — its
Workspace closed or removed, so `inheritSourceWorkspaceId` returns null — the
fallback used to inject the worktree's first Bundle. It now injects nothing.
That is the better default (injecting a Bundle nobody chose is worse than
injecting none), it is visible — the pill disappears and the dialog says "No
bundle is injected" — and it is pinned by
`own_bundles_with_no_flag_inject_nothing_without_a_parent`. No backfill: the
distinction between "opted out" and "never had a flag" is not worth writing a
flag nobody asked for.

## Threat model, stated precisely

**Protected:** data at rest. A copy of `abundio.db`, a stray backup, or a Time
Machine snapshot yields ciphertext. Variable *names* are plaintext — they are
needed to build a shell environment and to render the settings list without
prompting for keychain access — so the set of names leaks, but no value does.

**Not protected:** a process running as the same user. An injected value is
readable via `env` by anything in that PTY; that is inherent to the feature. An
on-demand Bundle is stronger — nothing on disk, nothing in any process
environment — but code running *inside* a pane can read `ABUNDIO_HOOK_TOKEN` and
ask the helper for it. This is a defence against disk scraping, not against a
targeted attacker who already runs as you.

**Not a boundary between panes, either.** Resolving the Workspace from
`ABUNDIO_PTY_ID` server-side stops a typo or a naive caller reaching another
Workspace, but it is not isolation: the hook token is process-wide and identical
in every pane, and every pane's `ABUNDIO_PTY_ID` is readable by any same-user
process (`/proc/<pid>/environ`, `ps eww`). The honest statement is "a process
running as you can read any Workspace's on-demand Bundles" — the token buys that
a process *outside* an Abundio terminal can read none of them.

**`zeroize` is best-effort.** Serde's IPC deserialization has already copied the
plaintext somewhere we cannot reach, and JS strings are immutable and
GC-managed. The frontend store holds at most **one** decrypted value at a time
(a single `revealed` slot, not a map); that bounds exposure rather than
eliminating it.

## Key storage

One 32-byte key, `keyring` v4's `v1` feature: macOS Keychain, Windows Credential
Manager, Linux Secret Service over pure-Rust zbus. Deliberately excluded:
`dbus-secret-service` (adds a libdbus C dependency to the Linux CI image) and
`linux-keyutils` (session-scoped, does not survive a reboot — which would present
as silent key loss).

A key **per variable** was rejected: Windows caps a generic credential blob at
2560 bytes, so a 3 KB certificate would hard-fail there.

**A credential-store failure never blocks a spawn.** Terminals open without the
variables, the workspace shows a banner with Retry, and rows render locked. The
alternative — a pane that will not open because a keychain hiccupped — is worse
than a pane missing its credentials.

## Injection wins over the user's rc

`CommandBuilder::env` runs *before* zsh sources `.zshrc`, so a plain
`export AWS_PROFILE=default` in an rc would silently beat the Workspace value.
Each variable is therefore emitted twice: under its own name, and as a shadow
`ABUNDIO_ENV__<NAME>` that the wrapper rc re-exports **after** the user's rc, then
unsets. Nothing is echoed to the terminal or written to shell history.

There is deliberately **no `eval`** in any wrapper: values are arbitrary user data
including quotes and newlines. zsh uses `${(P)name}` indirect expansion, bash uses
`${!name}` with `printf -v`, PowerShell uses the Environment API. Variable names
are validated as shell identifiers in **Rust**, not just the UI — the wrappers are
downstream of the IPC.

`ShellType::Other` has no wrapper and receives only the pre-rc values, so a user
rc can still shadow a Workspace variable there. Accepted, and stated in the UI.

## On-demand access: `run`, not `--env-file`

The original design was
`docker compose --env-file <(abundio-env print production) up`, so the values
would exist only as a pipe. **This does not work.** Docker Compose requires a
regular, seekable file and silently treats a process substitution as *empty* —
verified against Compose v5.1.3: no error, just blank values. A silently empty
environment is far worse than a missing feature, so the helper does not offer it.

The shipped primary path is:

```
abundio-env run production -- docker compose up
```

`run` applies the Bundle to a child's environment and execs it. Compose then
resolves `${VAR}` interpolation and `environment: [VAR]` passthrough from the
shell environment, which works. It also avoids two exposures `--env-file` never
could: no temp file for a scraper to find, and no `env KEY=VALUE cmd`, which would
put every value into `ps` output.

The transport is NUL-delimited `KEY=VALUE` records on `/env/raw` — NUL is the one
byte an environment variable cannot contain, so the reader needs no escaping rules
and no `eval`, and a certificate's newlines survive.

`abundio-env print` remains for deliberate redirection, and **refuses a TTY**:
Abundio persists scrollback to disk, so a bare `print` would write every secret
into a log file.

## Authorization

The helper rides the existing loopback hook server: same per-launch UUID token,
same constant-time comparison. The Workspace is resolved server-side from
`ABUNDIO_PTY_ID` through the PtyManager's spawn-context map and is **never** taken
from the request body — a caller can name a Bundle but not a Workspace.

## Inheritance

A linked git worktree inherits its main worktree's Bundles **by name**; a
same-named own variable overrides the inherited one. The main-worktree id is
resolved in TypeScript (`inheritSourceWorkspaceId`, the same grouping rules as
`buildWorkspaceRows`) and passed to `pty_spawn`, rather than recomputing git
grouping on the spawn hot path. Editing an inherited value writes an own row,
leaving the parent untouched.

## Consequences

- Migration 013 **drops** the vestigial `workspaces.env_json`. A rollback to a
  pre-013 binary breaks `workspace_list` — the Stage 0 backup is the only way
  back, and this needs a release-notes warning.
- `PATH` is allowed. Because the re-export runs after the rc, setting it
  *replaces* the rc-built PATH (nvm, pyenv, homebrew shims). Deliberate, and the
  wrappers re-prepend the integration dir afterwards so `abundio-env` survives.
- Shadow variables double the environment cost, and Windows caps the whole block
  at 32,767 characters with `CreateProcess` failing on overflow. The injected
  Bundle is budget-checked at write time (tighter on Windows) and defensively
  truncated at spawn. Moving a large value to an on-demand Bundle sidesteps the
  budget entirely.
- The key cache and `EnvVarStore` are process-global, shared by every window.
  Since a Profile is owned by exactly one window (ADR-0007), a Workspace's dialog
  can only be open in one place; `env_retry_key` invalidating for all windows is
  the intended semantics for "the keychain was just unlocked".
