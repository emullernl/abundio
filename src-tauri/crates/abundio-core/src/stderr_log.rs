//! The desktop app's log: every `log::` line on stderr, which is the terminal
//! `pnpm tauri dev` runs in (a released app's stderr goes nowhere). Abundio's
//! own lines at info, other crates' at warn; `ABUNDIO_LOG=debug` (or
//! `trace`, `warn`) for more or less. Without it every `log::` line in the
//! app was dropped (the server has its own, `abundio-server`'s `StderrLog`).

struct StderrLog {
    own: log::LevelFilter,
    others: log::LevelFilter,
}

impl StderrLog {
    fn level_for(&self, target: &str) -> log::LevelFilter {
        if target.starts_with("abundio") {
            self.own
        } else {
            self.others
        }
    }
}

impl log::Log for StderrLog {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= self.level_for(m.target())
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            let ts = chrono::Local::now().format("%H:%M:%S%.3f");
            eprintln!("[{ts}] {} {}: {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

/// Install the log, once; later calls do nothing.
pub fn init() {
    let own = match std::env::var("ABUNDIO_LOG").as_deref() {
        Ok("trace") => log::LevelFilter::Trace,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("warn") => log::LevelFilter::Warn,
        _ => log::LevelFilter::Info,
    };
    let logger = StderrLog { own, others: log::LevelFilter::Warn };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(own.max(log::LevelFilter::Warn));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abundios_own_lines_are_louder_than_other_crates() {
        let l = StderrLog { own: log::LevelFilter::Info, others: log::LevelFilter::Warn };
        assert_eq!(l.level_for("abundio_core::app_paths"), log::LevelFilter::Info);
        assert_eq!(l.level_for("abundio_lib::host_commands"), log::LevelFilter::Info);
        assert_eq!(l.level_for("tao::platform"), log::LevelFilter::Warn);
    }
}
