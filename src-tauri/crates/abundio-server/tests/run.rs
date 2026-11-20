//! The real binary, run with a data folder of its own.

#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// The server, killed when the test ends however it ends: a failed check
/// must not leave it running (it holds the test's output open).
struct Server(Child);

impl std::ops::Deref for Server {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}

impl std::ops::DerefMut for Server {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn server(dir: &std::path::Path) -> Server {
    Server(
        Command::new(env!("CARGO_BIN_EXE_abundio-server"))
            .args(["run", "--data-dir"])
            .arg(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
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

struct Quiet;

impl abundio_core::host_client::HostListener for Quiet {
    fn event(&self, _client: Option<&str>, _name: &str, _payload: serde_json::Value) {}
    fn pty(&self, _client: &str, _pty_id: &str, _bytes: &[u8]) {}
    fn closed(&self, _why: &str) {}
}

fn connect_command(dir: &std::path::Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_abundio-server"));
    c.args(["connect", "--data-dir"]).arg(dir);
    c
}

#[test]
fn the_app_reaches_the_server_through_connect() {
    use abundio_core::host_client::HostProcess;
    let dir = tempfile::tempdir().unwrap();

    // No server yet: connect says so.
    let Err(e) = HostProcess::spawn(connect_command(dir.path()), std::sync::Arc::new(Quiet)) else {
        panic!("connected to no server");
    };
    assert!(e.contains("no Abundio server is running"), "{e}");

    let mut server = server(dir.path());
    let mut log = BufReader::new(server.stderr.take().unwrap()).lines().map_while(Result::ok);
    let hook_line = wait_for(&mut log, "hook server on 127.0.0.1:");
    let port: u16 = hook_line.rsplit(':').next().unwrap().trim().parse().unwrap();
    wait_for(&mut log, "waiting for a Client");
    // Agent control is answered on the Host: a token no pane holds is refused.
    {
        use std::io::{Read, Write};
        let mut http = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(http, "POST /control HTTP/1.1\r\nHost: x\r\nX-Abundio-Agent-Token: nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        let mut answer = String::new();
        http.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 403"), "{answer}");
        assert!(answer.contains("unauthorized"), "{answer}");
    }
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.path().join("server.sock")), 0o600);
        assert_eq!(mode(dir.path()), 0o700);
    }

    let (client, process) = HostProcess::spawn(connect_command(dir.path()), std::sync::Arc::new(Quiet)).unwrap();
    assert_eq!(client.server_version, env!("CARGO_PKG_VERSION"));
    let pong = client
        .request("window-1", "server_ping", serde_json::Value::Null, Some(Duration::from_secs(10)))
        .unwrap();
    assert_eq!(pong["version"], env!("CARGO_PKG_VERSION"));
    wait_for(&mut log, "a Client connection opened");

    // The host commands run on the server: a Workspace, then a terminal in it.
    let call = |command: &str, args: serde_json::Value| {
        client.request("window-1", command, args, Some(Duration::from_secs(10)))
    };
    let profile = "00000000-0000-0000-0000-000000000001";
    let folder = tempfile::tempdir().unwrap();
    let ws = call(
        "workspace_create",
        serde_json::json!({ "name": "Remote", "rootFolder": folder.path(), "profileId": profile }),
    )
    .unwrap();
    let listed = call("workspace_list", serde_json::json!({ "profileId": profile })).unwrap();
    assert_eq!(listed[0]["id"], ws["id"]);
    let pty = call(
        "pty_spawn",
        serde_json::json!({
            "cwd": folder.path(), "cols": 80, "rows": 24,
            "command": "/bin/echo made-on-the-host", "workspaceId": ws["id"],
        }),
    )
    .unwrap();
    let pty = pty.as_str().unwrap().to_string();
    let start = Instant::now();
    loop {
        let screen = call("pty_read_screen", serde_json::json!({ "ptyId": pty, "visible": true })).unwrap();
        if screen.as_array().unwrap().iter().any(|l| l.as_str().unwrap_or("").contains("made-on-the-host")) {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "no output: {screen}");
        std::thread::sleep(Duration::from_millis(50));
    }
    // Files on the Host.
    let file = folder.path().join("notes.md");
    call("fs_write_file", serde_json::json!({ "path": file, "content": "# on the host" })).unwrap();
    let read = call("fs_read_file", serde_json::json!({ "path": file })).unwrap();
    assert_eq!(read["content"], "# on the host");
    let listed = call("fs_list_dir", serde_json::json!({ "path": folder.path() })).unwrap();
    assert_eq!(listed[0]["name"], "notes.md");
    // Notes and Prompt actions live on the Host too.
    call("note_set", serde_json::json!({ "workspaceId": ws["id"], "content": "remember" })).unwrap();
    assert_eq!(call("note_get", serde_json::json!({ "workspaceId": ws["id"] })).unwrap(), "remember");
    let before = call("prompt_actions_list", serde_json::Value::Null).unwrap().as_array().unwrap().len();
    call(
        "prompt_action_create",
        serde_json::json!({ "action": { "name": "Review", "body": "Review this" } }),
    )
    .unwrap();
    let after = call("prompt_actions_list", serde_json::Value::Null).unwrap().as_array().unwrap().len();
    assert_eq!(after, before + 1);
    // A host command's error reaches the app as the command's own.
    let err = call("pty_resize", serde_json::json!({ "ptyId": "nope", "cols": 1, "rows": 1 })).unwrap_err();
    assert!(format!("{err:?}").contains("PTY not found"), "{err:?}");

    // The app goes: the server notices and keeps running.
    process.kill();
    wait_for(&mut log, "a Client connection closed");
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(server.id() as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
    assert!(server.wait().unwrap().success());
}

#[derive(Default)]
struct Windows {
    events: std::sync::Mutex<Vec<(String, String)>>,
    frames: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
}

impl abundio_core::host_router::WindowSink for Windows {
    fn emit_to(&self, window: &str, event: &str, _payload: serde_json::Value) {
        self.events.lock().unwrap().push((window.to_string(), event.to_string()));
    }
    fn pty_frame(&self, window: &str, frame: &[u8]) {
        self.frames.lock().unwrap().push((window.to_string(), frame.to_vec()));
    }
}

#[test]
fn windows_on_a_host_get_its_answers_events_and_output() {
    use abundio_core::host_router::{HostRouter, HostTarget};
    let dir = tempfile::tempdir().unwrap();
    let mut server = server(dir.path());
    let mut log = BufReader::new(server.stderr.take().unwrap()).lines().map_while(Result::ok);
    wait_for(&mut log, "waiting for a Client");

    let windows = std::sync::Arc::new(Windows::default());
    let router = HostRouter::new(windows.clone());
    let target = HostTarget::Direct {
        server: env!("CARGO_BIN_EXE_abundio-server").into(),
        data_dir: Some(dir.path().to_string_lossy().into_owned()),
    };
    router.connect("box", &target, &abundio_core::host_router::ConnectMode::Batch).unwrap();
    router.bind("w1", Some("box"));
    router.bind("w2", Some("box"));
    // A Window on this computer is not routed.
    assert!(router.call("local", "workspace_list", serde_json::json!({})).is_none());

    let call = |w: &str, command: &str, args: serde_json::Value| router.call(w, command, args).unwrap().unwrap();
    let profile = "00000000-0000-0000-0000-000000000001";
    let folder = tempfile::tempdir().unwrap();
    let ws = call("w1", "workspace_create", serde_json::json!({ "name": "R", "rootFolder": folder.path(), "profileId": profile }));
    let pty = format!("pty-{}", std::process::id());
    call("w1", "status_apply", serde_json::json!({ "ops": [{ "op": "init", "ptyId": pty, "mode": "shell" }] }));
    call(
        "w1",
        "pty_spawn",
        serde_json::json!({
            "cwd": folder.path(), "cols": 80, "rows": 24, "ptyId": pty,
            "command": "/bin/echo routed-output", "workspaceId": ws["id"],
        }),
    );

    // The output reaches both Windows on the Host, framed as local output.
    let start = Instant::now();
    loop {
        let frames = windows.frames.lock().unwrap().clone();
        let seen = |w: &str| {
            frames.iter().any(|(win, f)| win == w && String::from_utf8_lossy(f).contains("routed-output"))
        };
        if seen("w1") && seen("w2") {
            assert!(frames.iter().all(|(w, _)| w != "local"));
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "no output reached the Windows");
        std::thread::sleep(Duration::from_millis(50));
    }

    // A command that fails: its status goes to the Window that owns it only.
    let failing = format!("failing-{}", std::process::id());
    call("w1", "status_apply", serde_json::json!({ "ops": [{ "op": "init", "ptyId": failing, "mode": "shell" }] }));
    call(
        "w1",
        "pty_spawn",
        serde_json::json!({
            "cwd": folder.path(), "cols": 80, "rows": 24, "ptyId": failing,
            "command": "/usr/bin/false", "workspaceId": ws["id"],
        }),
    );
    let start = Instant::now();
    loop {
        let events = windows.events.lock().unwrap().clone();
        if events.iter().any(|(w, e)| w == "w1" && e == "status-updates") {
            assert!(!events.iter().any(|(w, e)| w == "w2" && e == "status-updates"));
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "no status update: {events:?}");
        std::thread::sleep(Duration::from_millis(50));
    }

    // The server goes: every Window on it hears so, and calls say so.
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(server.id() as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
    assert!(server.wait().unwrap().success());
    let start = Instant::now();
    while !windows.events.lock().unwrap().iter().any(|(w, e)| w == "w2" && e == "host-connection-lost") {
        assert!(start.elapsed() < Duration::from_secs(10), "no connection-lost event");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(router.call("w1", "workspace_list", serde_json::json!({})).unwrap().is_err());
}
