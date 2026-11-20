//! Setting up a Host (docs/plans/remote-hosts.md phase 8, "Host setup"):
//! what the app learns about a Host before it installs anything (the
//! **probe**, one short `ssh <host> sh -s` with this script on its stdin),
//! and the **checklist** it shows from that: a ✓ or a fix per line.
//!
//! The probe changes nothing on the Host. Everything it says comes back as
//! `ABUNDIO <key>=<value>` lines, so whatever a login shell prints around
//! them (a banner, a motd) is ignored.

use serde::Serialize;

/// Where the server lives on a Host: `<version>/abundio-server` for each
/// version installed, `current` a link to the one in use, `data/` its data.
pub const SERVER_DIR: &str = ".abundio-server";

/// The script the probe runs, with the Agents' commands to look for as its
/// arguments. POSIX sh: it runs before we know which shell the Host has.
pub const PROBE_SCRIPT: &str = r#"
p() { printf 'ABUNDIO %s=%s\n' "$1" "$2"; }
p os "$(uname -s)"
p arch "$(uname -m)"
p user "$(id -un)"
p home "$HOME"
if [ -w "$HOME" ]; then p home_writable yes; else p home_writable no; fi
d="$HOME/.abundio-server"
for v in "$d"/*/abundio-server; do
  [ -x "$v" ] && p installed "$(basename "$(dirname "$v")")"
done
if [ -x "$d/current" ]; then
  p current "$("$d/current" version 2>/dev/null | sed 's/^abundio-server //')"
fi
# `[a]`: the pattern never matches this script's own command line.
if command -v pgrep >/dev/null 2>&1 && pgrep -u "$(id -u)" -f '[a]bundio-server run' >/dev/null 2>&1; then
  p running yes
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  p systemd_user yes
fi
if command -v loginctl >/dev/null 2>&1; then
  p linger "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
fi
command -v launchctl >/dev/null 2>&1 && p launchd yes
[ -f "$HOME/.config/systemd/user/abundio-server.service" ] && p service systemd
[ -f "$HOME/Library/LaunchAgents/dev.abundio.server.plist" ] && p service launchd
# Agents, git and gh as a pane would find them: on the PATH of the user's
# own interactive login shell, given 15 s in case its startup files wait.
inner='p() { printf "ABUNDIO %s=%s\n" "$1" "$2"; }
for a in "$@"; do command -v "$a" >/dev/null 2>&1 && p agent "$a"; done
command -v git >/dev/null 2>&1 && p git "$(git --version 2>/dev/null)"
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then p gh signed_in; else p gh signed_out; fi
fi
p shell_done yes'
"${SHELL:-/bin/sh}" -lic "$inner" probe "$@" </dev/null 2>/dev/null &
pid=$!
( sleep 15; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
killer=$!
wait "$pid" 2>/dev/null
kill "$killer" 2>/dev/null
p done yes
"#;

/// Install a server (phase 8b), then probe as `PROBE_SCRIPT` does. Its
/// arguments: the OS and CPU the app picked the binary for, the version,
/// the binary's SHA-256 and size, then the Agents to look for. The binary
/// itself is on stdin. Nothing changes unless the Host is still that
/// platform and the bytes arrive whole; `current` moves last, atomically.
pub const INSTALL_SCRIPT: &str = r#"
set -eu
os="$1"; arch="$2"; v="$3"; want="$4"; size="$5"; shift 5
[ "$(uname -s) $(uname -m)" = "$os $arch" ] || { echo "the Host is no longer $os $arch" >&2; exit 2; }
umask 022
d="$HOME/.abundio-server"
mkdir -p "$d/$v"
chmod 700 "$d"
f="$d/$v/abundio-server"
head -c "$size" > "$f.part"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$f.part" | cut -d ' ' -f 1)
else got=$(shasum -a 256 "$f.part" | cut -d ' ' -f 1); fi
if [ "$got" != "$want" ]; then rm -f "$f.part"; echo "the upload arrived damaged (checksum mismatch)" >&2; exit 3; fi
chmod 755 "$f.part"
mv -f "$f.part" "$f"
"$f" version >/dev/null 2>&1 || { echo "the server does not run on this Host" >&2; exit 4; }
rm -f "$d/current.new"
ln -s "$v/abundio-server" "$d/current.new"
mv -f "$d/current.new" "$d/current"
printf 'ABUNDIO install_done=%s\n' "$v"
"#;

/// Install, then probe, in one ssh (one password prompt).
pub fn install_then_probe() -> String {
    format!("{INSTALL_SCRIPT}\nset +eu\n{PROBE_SCRIPT}")
}

/// `text` as one word for a POSIX shell.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// An Agent command the probe may look for: one plain word, since it is
/// handed to the Host's shell.
pub fn probe_word(command: &str) -> Option<&str> {
    let word = command.split_whitespace().next()?;
    (!word.starts_with('-') && word.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))).then_some(word)
}

/// What the probe found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub os: String,
    pub arch: String,
    pub user: String,
    pub home: String,
    pub home_writable: bool,
    /// Versions in `~/.abundio-server/<version>/`.
    pub installed: Vec<String>,
    /// The version `current` points at.
    pub current: Option<String>,
    pub running: bool,
    pub systemd_user: bool,
    /// `None`: no `loginctl`.
    pub linger: Option<bool>,
    pub launchd: bool,
    /// `systemd` or `launchd`: the service the app wrote.
    pub service: Option<String>,
    pub agents: Vec<String>,
    pub git: Option<String>,
    /// `signed_in`, `signed_out`, or `None` when gh is missing.
    pub gh: Option<String>,
    /// The login shell answered in time.
    pub shell_answered: bool,
    /// The whole script ran.
    pub complete: bool,
    /// The version an install just put in place.
    pub installed_now: Option<String>,
}

pub fn parse_probe(text: &str) -> Probe {
    let mut p = Probe::default();
    for line in text.lines() {
        let Some((key, value)) = line.trim_end().strip_prefix("ABUNDIO ").and_then(|l| l.split_once('=')) else {
            continue;
        };
        let value = value.trim().to_string();
        match key {
            "os" => p.os = value,
            "arch" => p.arch = value,
            "user" => p.user = value,
            "home" => p.home = value,
            "home_writable" => p.home_writable = value == "yes",
            "installed" if !value.is_empty() => p.installed.push(value),
            "current" if !value.is_empty() => p.current = Some(value),
            "running" => p.running = value == "yes",
            "systemd_user" => p.systemd_user = value == "yes",
            "linger" => p.linger = Some(value == "yes"),
            "launchd" => p.launchd = value == "yes",
            "service" => p.service = Some(value),
            "agent" if !p.agents.contains(&value) => p.agents.push(value),
            "git" => p.git = Some(value),
            "gh" => p.gh = Some(value),
            "shell_done" => p.shell_answered = true,
            "done" => p.complete = true,
            "install_done" => p.installed_now = Some(value),
            _ => {}
        }
    }
    p
}

/// The release asset a Host runs, or why it has none.
pub fn platform(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("Linux", "x86_64" | "amd64") => Ok("linux-x86_64"),
        ("Linux", "aarch64" | "arm64") => Ok("linux-aarch64"),
        ("Darwin", "x86_64" | "arm64") => Ok("macos-universal"),
        _ => Err(format!("{os} {arch} is not supported yet")),
    }
}

/// One line of the checklist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub id: &'static str,
    pub label: String,
    /// `ok`, `warn` (works, with a gap) or `error` (blocks using the Host).
    pub state: &'static str,
    /// What fixes it, in words.
    pub fix: Option<String>,
    /// The button that fixes it: `install`, `update`, `start`.
    pub action: Option<&'static str>,
}

fn item(id: &'static str, state: &'static str, label: impl Into<String>) -> CheckItem {
    CheckItem { id, label: label.into(), state, fix: None, action: None }
}

impl CheckItem {
    fn fix(mut self, fix: impl Into<String>) -> Self {
        self.fix = Some(fix.into());
        self
    }
    fn action(mut self, action: &'static str) -> Self {
        self.action = Some(action);
        self
    }
}

/// The checklist for a Host this app (`version`) would use.
pub fn checklist(p: &Probe, version: &str) -> Vec<CheckItem> {
    let mut out = Vec::new();
    if !p.complete {
        out.push(
            item("probe", "error", "The Host did not answer every question")
                .fix("Check that its shell is POSIX-compatible, then Check again."),
        );
    }
    let supported = platform(&p.os, &p.arch);
    out.push(match &supported {
        Ok(_) => item("platform", "ok", format!("{} {}", p.os, p.arch)),
        Err(why) => item("platform", "error", why.clone()),
    });
    if !p.home_writable {
        out.push(
            item("home", "error", format!("The home folder {} is not writable", p.home))
                .fix("The server installs into ~/.abundio-server without root."),
        );
    }
    let server = match p.current.as_deref() {
        Some(v) if v == version => item("server", "ok", format!("Server {v} installed")),
        Some(v) => item("server", "error", format!("Server {v} installed; this app needs {version}"))
            .fix("Update installs this app's version.")
            .action("update"),
        None => item("server", "error", "Server not installed")
            .fix("Install uploads it to ~/.abundio-server; no root needed.")
            .action("install"),
    };
    let installed = server.state == "ok";
    out.push(if supported.is_err() { CheckItem { action: None, ..server } } else { server });
    if installed {
        out.push(if p.running {
            item("running", "ok", "Running")
        } else {
            item("running", "error", "Not running").action("start")
        });
    }
    out.push(reboot_item(p));
    out.push(if p.agents.is_empty() {
        item("agents", "warn", "No Agents found").fix(if p.shell_answered {
            "Install one on the Host, then Check again."
        } else {
            "The login shell did not answer in 15 s, so Agents could not be looked for."
        })
    } else {
        item("agents", "ok", format!("Agents: {}", p.agents.join(", ")))
    });
    out.push(match &p.git {
        Some(v) => item("git", "ok", v.clone()),
        None => item("git", "warn", "git not found").fix("The git panel and worktrees need it."),
    });
    out.push(match p.gh.as_deref() {
        Some("signed_in") => item("gh", "ok", "gh signed in"),
        Some(_) => item("gh", "warn", "gh not signed in").fix("Run gh auth login in a pane on the Host."),
        None => item("gh", "warn", "gh not found").fix("GitHub issues in New task need it."),
    });
    out
}

fn reboot_item(p: &Probe) -> CheckItem {
    match (p.os.as_str(), p.service.as_deref()) {
        ("Linux", Some("systemd")) if p.linger == Some(true) => item("reboot", "ok", "Comes back after a reboot"),
        ("Linux", Some("systemd")) => item("reboot", "warn", "Stops when you log out of the Host")
            .fix(format!("Run once on the Host: sudo loginctl enable-linger {}", p.user)),
        ("Linux", _) if p.systemd_user => item("reboot", "warn", "Not set up to come back after a reboot")
            .fix("Install sets up a systemd user service."),
        ("Linux", _) => item("reboot", "warn", "Won't come back after a reboot (no systemd --user)")
            .fix("Start it again from here after a reboot."),
        ("Darwin", Some("launchd")) => item("reboot", "ok", "Starts when you log in on the Mac"),
        ("Darwin", _) => item("reboot", "warn", "Not set up to start at login")
            .fix("Install sets up a LaunchAgent."),
        _ => item("reboot", "warn", "Won't come back after a reboot"),
    }
}

/// Run `command` with `script` on its stdin, for at most `limit` (a
/// password prompt in between counts). Its stdout, or why it failed: its
/// stderr's last lines when it said nothing useful.
pub fn run_script(command: std::process::Command, script: &str, limit: std::time::Duration) -> Result<String, String> {
    run(command, Box::new(std::io::Cursor::new(script.as_bytes().to_vec())), limit)
}

/// Run `command` with `input` on its stdin, for at most `limit`. Its stdout,
/// or why it failed: its stderr's last lines when it said nothing useful.
pub fn run(
    mut command: std::process::Command,
    mut input: Box<dyn std::io::Read + Send>,
    limit: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("cannot start {:?}: {e}", command.get_program()))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut input, &mut stdin);
    });
    let read = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = r.read_to_string(&mut s);
            s
        })
    };
    let out = read(Box::new(child.stdout.take().ok_or("no stdout")?));
    let err = read(Box::new(child.stderr.take().ok_or("no stderr")?));
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the Host did not answer in time".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if status.success() || out.contains("ABUNDIO ") {
        Ok(out)
    } else {
        let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(3)..].join("\n");
        Err(if tail.is_empty() { format!("it ended with {status}") } else { tail })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX: &str = "Welcome to box!\nABUNDIO os=Linux\nABUNDIO arch=x86_64\nABUNDIO user=dev\nABUNDIO home=/home/dev\nABUNDIO home_writable=yes\nABUNDIO installed=3.0.0\nABUNDIO installed=3.1.0\nABUNDIO current=3.1.0\nABUNDIO running=yes\nABUNDIO systemd_user=yes\nABUNDIO linger=no\nABUNDIO service=systemd\nlast login: never\nABUNDIO agent=claude\nABUNDIO agent=codex\nABUNDIO git=git version 2.43.0\nABUNDIO gh=signed_out\nABUNDIO shell_done=yes\nABUNDIO done=yes\n";

    #[test]
    fn reads_what_the_probe_said_and_nothing_else() {
        let p = parse_probe(LINUX);
        assert_eq!((p.os.as_str(), p.arch.as_str(), p.user.as_str()), ("Linux", "x86_64", "dev"));
        assert_eq!(p.installed, ["3.0.0", "3.1.0"]);
        assert_eq!(p.current.as_deref(), Some("3.1.0"));
        assert!(p.running && p.systemd_user && p.home_writable && p.complete && p.shell_answered);
        assert_eq!(p.linger, Some(false));
        assert_eq!(p.agents, ["claude", "codex"]);
        assert_eq!(p.gh.as_deref(), Some("signed_out"));
        assert_eq!(parse_probe("ABUNDIO current=\n").current, None);
    }

    #[test]
    fn the_checklist_says_what_to_fix() {
        let p = parse_probe(LINUX);
        let list = checklist(&p, "3.1.0");
        let get = |id: &str| list.iter().find(|i| i.id == id).unwrap().clone();
        assert_eq!(get("server").state, "ok");
        assert_eq!(get("running").state, "ok");
        assert_eq!(get("reboot").state, "warn");
        assert!(get("reboot").fix.unwrap().contains("sudo loginctl enable-linger dev"));
        assert_eq!(get("gh").state, "warn");
        // Another app version: Update.
        let list = checklist(&p, "3.2.0");
        let server = list.iter().find(|i| i.id == "server").unwrap();
        assert_eq!((server.state, server.action), ("error", Some("update")));
        assert!(!list.iter().any(|i| i.id == "running"));
        // Nothing installed: Install.
        let bare = Probe { current: None, installed: vec![], ..p.clone() };
        assert_eq!(checklist(&bare, "3.1.0").iter().find(|i| i.id == "server").unwrap().action, Some("install"));
        // A platform with no server: nothing to install.
        let odd = Probe { os: "FreeBSD".into(), arch: "amd64".into(), current: None, ..p };
        let list = checklist(&odd, "3.1.0");
        assert_eq!(list.iter().find(|i| i.id == "platform").unwrap().state, "error");
        assert_eq!(list.iter().find(|i| i.id == "server").unwrap().action, None);
    }

    #[test]
    fn only_plain_words_reach_the_hosts_shell() {
        assert_eq!(probe_word("claude --dangerously-skip"), Some("claude"));
        assert_eq!(probe_word("my-agent.sh"), Some("my-agent.sh"));
        assert_eq!(probe_word("$(rm -rf ~)"), None);
        assert_eq!(probe_word("-x"), None);
        assert_eq!(probe_word(""), None);
    }

    #[test]
    fn knows_which_server_a_host_runs() {
        assert_eq!(platform("Linux", "x86_64"), Ok("linux-x86_64"));
        assert_eq!(platform("Linux", "aarch64"), Ok("linux-aarch64"));
        assert_eq!(platform("Darwin", "arm64"), Ok("macos-universal"));
        assert!(platform("Linux", "riscv64").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_script_that_fails_says_why_and_one_that_hangs_is_stopped() {
        let sh = || std::process::Command::new("/bin/sh");
        let err = run_script(sh(), "echo nope >&2; exit 3", std::time::Duration::from_secs(5)).unwrap_err();
        assert_eq!(err, "nope");
        let err = run_script(sh(), "sleep 5", std::time::Duration::from_millis(200)).unwrap_err();
        assert!(err.contains("in time"));
        assert_eq!(run_script(sh(), "echo ok", std::time::Duration::from_secs(5)).unwrap(), "ok\n");
    }

    #[test]
    fn quotes_anything_as_one_word() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's $(x)"), "'it'\\''s $(x)'");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf %s {}", shell_quote("it's $(echo no) `x` \"q\""))])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "it's $(echo no) `x` \"q\"");
    }

    /// The install script, run here on a fake binary: the server lands in
    /// its version's folder and `current` points at it; damaged bytes or
    /// another platform change nothing.
    #[cfg(unix)]
    #[test]
    fn installs_a_server_and_moves_current_last() {
        use sha2::Digest;
        let home = tempfile::tempdir().unwrap();
        let binary = b"#!/bin/sh\necho abundio-server 9.9.9\n".to_vec();
        let sha = format!("{:x}", sha2::Sha256::digest(&binary));
        let uname = |flag: &str| {
            String::from_utf8(std::process::Command::new("uname").arg(flag).output().unwrap().stdout).unwrap().trim().to_string()
        };
        let (os, arch) = (uname("-s"), uname("-m"));
        let install = |os: &str, sha: &str, bytes: Vec<u8>| {
            let mut c = std::process::Command::new("/bin/sh");
            let script = install_then_probe();
            c.args(["-c", &script, "abundio-setup", os, &arch, "9.9.9", sha, &binary.len().to_string()])
                .env("HOME", home.path());
            run(c, Box::new(std::io::Cursor::new(bytes)), std::time::Duration::from_secs(10))
        };
        let current = home.path().join(".abundio-server/current");
        // Another platform: nothing happens.
        assert!(install("Plan9", &sha, binary.clone()).unwrap_err().contains("no longer"));
        assert!(!home.path().join(".abundio-server").exists());
        // Damaged on the way: nothing is kept.
        let mut bad = binary.clone();
        bad[3] ^= 1;
        assert!(install(&os, &sha, bad).unwrap_err().contains("damaged"));
        assert!(!current.exists());
        // Whole: installed, and `current` runs it.
        let out = install(&os, &sha, binary.clone()).unwrap();
        assert_eq!(parse_probe(&out).installed_now.as_deref(), Some("9.9.9"));
        let v = std::process::Command::new(&current).arg("version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&v.stdout).trim(), "abundio-server 9.9.9");
        assert_eq!(std::fs::read_link(&current).unwrap(), std::path::Path::new("9.9.9/abundio-server"));
    }

    /// The real script, run here: it answers every question.
    #[cfg(unix)]
    #[test]
    fn the_script_runs_on_this_computer() {
        let gh = tempfile::tempdir().unwrap();
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", PROBE_SCRIPT, "probe", "sh", "no-such-agent-xyz"])
            .env("SHELL", "/bin/sh")
            // Never the user's own gh login (gh would ask GitHub).
            .env("GH_CONFIG_DIR", gh.path())
            .output()
            .unwrap();
        let p = parse_probe(&String::from_utf8_lossy(&out.stdout));
        assert!(p.complete, "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!p.os.is_empty() && !p.home.is_empty());
        assert_eq!(p.agents, ["sh"]);
    }
}
