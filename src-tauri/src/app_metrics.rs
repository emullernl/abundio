//! Background sampler for system-wide resource usage.
//!
//! Scope is the **whole machine**, not Abundio specifically. Measuring
//! Abundio's own footprint turned out to be impossible to do robustly on macOS
//! (its heavy memory lives in WebKit content processes that the OS reparents to
//! launchd and only re-groups via private/contaminated APIs) — see ADR-0011.
//! So this reports total CPU load and total memory pressure, which is honest,
//! cheap, and cross-platform.
//!
//! Why a pushed event (not an `invoke` command): like `git_scheduler.rs`, this
//! avoids the per-call WKWebView main-thread interference that `invoke()`
//! incurs. One sampler thread serves every window, and the timer cadence also
//! satisfies sysinfo's requirement that CPU usage be derived as a delta between
//! two spaced refreshes.

use std::thread;
use std::time::Duration;

use sysinfo::System;
use tauri::{AppHandle, Emitter};

use crate::events::AppMetrics;

/// How often the machine is sampled. Comfortably above sysinfo's minimum CPU
/// delta window, and slow enough to be negligible overhead while still feeling
/// "live" in the status bar.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(1500);

/// Spawn the sampler. Runs for the lifetime of the app; the loop exits on its
/// own once `emit` starts failing (i.e. the app is tearing down).
pub fn start_metrics_sampler(app: AppHandle) {
    thread::spawn(move || {
        let mut sys = System::new();

        // Prime the CPU baseline. sysinfo computes CPU usage as a delta between
        // consecutive refreshes, so the first read is 0% — we take our first
        // real sample only after the first sleep below.
        sys.refresh_cpu_usage();

        loop {
            thread::sleep(SAMPLE_INTERVAL);
            sys.refresh_cpu_usage();
            sys.refresh_memory();

            let metrics = AppMetrics {
                cpu_percent: sys.global_cpu_usage().clamp(0.0, 100.0),
                memory_used_bytes: sys.used_memory(),
                memory_total_bytes: sys.total_memory(),
            };
            if app.emit("app-metrics", &metrics).is_err() {
                // No receivers / invalid handle — the app is shutting down.
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_system_load() {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        // Second refresh after a gap so global CPU has a delta window.
        thread::sleep(Duration::from_millis(300));
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let m = AppMetrics {
            cpu_percent: sys.global_cpu_usage().clamp(0.0, 100.0),
            memory_used_bytes: sys.used_memory(),
            memory_total_bytes: sys.total_memory(),
        };

        // A running machine always has some total RAM and some in use.
        assert!(m.memory_total_bytes > 0, "expected non-zero total memory");
        assert!(m.memory_used_bytes > 0, "expected non-zero used memory");
        assert!(m.memory_used_bytes <= m.memory_total_bytes);
        assert!((0.0..=100.0).contains(&m.cpu_percent));
    }
}
