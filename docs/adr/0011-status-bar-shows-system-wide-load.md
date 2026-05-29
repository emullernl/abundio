# Status bar shows system-wide CPU/memory, not Abundio's own footprint

The Status bar's resource readout reports **machine-wide** CPU and memory load
(via `sysinfo`'s `global_cpu_usage` and `used_memory`/`total_memory`), even
though the original request was "show CPU and memory usage of the application".
We deliberately do **not** attempt to measure Abundio's own footprint.

## Why

Measuring "Abundio specifically" turns out to be impossible to do *robustly* on
macOS, where the app's heavy memory lives in WebKit content processes
(`tauri://localhost` / `com.apple.WebKit.WebContent`), not the native host. On
the development machine the native host was **~97 MB** while the two WebContent
processes were **~468 MB + ~374 MB** — i.e. the host is ~10% of the true ~1 GB
footprint. A host-only number would under-report by ~10×.

Every mechanism for re-attributing those helpers to Abundio failed empirically
(see `Considered options`), so a per-app number would be either grossly wrong
(host-only) or fragile and contaminated (private attribution APIs). System-wide
load is honest, robust, cross-platform, and needs no attribution — at the cost
of answering "your Mac's load" rather than "Abundio's". The Status bar labels it
as system load (tooltip) to set that expectation.

## Considered options

- **Parent→child process-tree walk** (initially implemented): misses *all*
  WebKit helpers — macOS reparents them to `launchd` (`ppid 1`), so they are not
  descendants of the host.
- **`responsibility_get_pid_for_pid`** (the API Activity Monitor's grouped view
  uses): the symbol does not resolve in `libSystem`/`RTLD_DEFAULT` on the target
  machine — unusable.
- **Resource coalitions** (`proc_pidinfo` + `PROC_PIDCOALITIONINFO`): the
  coalition is inherited from the launching shell, so Abundio (launched from a
  Warp terminal) shared a coalition with `claude`, `copilot`, `node`, Warp
  itself, and 15 shells. Summing it would attribute half the terminal session to
  Abundio. Also relies on a private, version-fragile struct layout.

## Consequences

- The number does not match the "Abundio" row in Activity Monitor (which shows
  host-only ~97 MB anyway, and uses `phys_footprint`, not the RSS `sysinfo`
  reports). This is expected.
- Memory at rest reads ~75% on macOS by design (compressor + caches keep RAM
  near-full), so the memory metric is rendered in neutral colour with **no
  threshold tinting** — an "amber at 70%" rule would be permanently tripped and
  convey nothing. Only **CPU** gets threshold colours (amber ≥85%, red ≥95%),
  since CPU genuinely returns to a calm baseline.
- The metric is still pushed from Rust on a ~1.5s timer (an `app-metrics` event)
  rather than polled via `invoke`, to avoid the WKWebView main-thread stall that
  motivated the Rust-pushed git refresh (see `git_scheduler.rs`) — but the
  sampler now does a single global `sysinfo` refresh instead of walking the
  process tree.
