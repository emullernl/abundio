//! The real binary, run with a data folder of its own.

#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn server(dir: &std::path::Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_abundio-server"))
        .args(["run", "--data-dir"])
        .arg(dir)
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

/// Read the server's log until a line contains `needle`.
fn wait_for(lines: &mut impl Iterator<Item = String>, needle: &str) -> String {
    let start = Instant::now();
    for line in lines {
        if line.contains(needle) {
            return line;
        }
        assert!(start.elapsed() < Duration::from_secs(30), "no {needle:?} in the log");
    }
    panic!("the log ended before {needle:?}");
}

#[test]
fn starts_alone_on_its_data_folder_and_stops_on_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = server(dir.path());
    let mut log = BufReader::new(first.stderr.take().unwrap()).lines().map_while(Result::ok);
    wait_for(&mut log, "hook server on 127.0.0.1:");
    wait_for(&mut log, "waiting for a Client");
    assert!(dir.path().join("v2").join("abundio.db").exists());
    // What a pane runs with is in the server's own folder.
    assert!(dir.path().join("hooks").join("abundio-hook.sh").exists());
    let integration = dir.path().join("v2").join("shell-integration");
    for name in [".zshrc", "abundio", "abundio-env"] {
        assert!(integration.join(name).exists(), "{name}");
    }
    let key = dir.path().join("env-master.key");
    assert_eq!(std::fs::read(&key).unwrap().len(), 32);
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&key).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // A second server on the same folder is refused.
    let second = Command::new(env!("CARGO_BIN_EXE_abundio-server"))
        .args(["run", "--data-dir"])
        .arg(dir.path())
        .output()
        .unwrap();
    assert_eq!(second.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&second.stderr).contains("already running"));

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(first.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    wait_for(&mut log, "stopped");
    assert!(first.wait().unwrap().success());
}

#[test]
fn prints_its_version() {
    let out = Command::new(env!("CARGO_BIN_EXE_abundio-server")).arg("version").output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("abundio-server "));
}
