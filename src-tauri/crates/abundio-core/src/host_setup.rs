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
  if command -v sha256sum >/dev/null 2>&1; then p current_sha "$(sha256sum "$d/current" | cut -d ' ' -f 1)"
  elif command -v shasum >/dev/null 2>&1; then p current_sha "$(shasum -a 256 "$d/current" | cut -d ' ' -f 1)"; fi
fi
# Running: the installed server's socket answers. With none installed, a
# server started by hand (`[a]`: never this script's own command line).
if [ -x "$d/current" ]; then
  "$d/current" connect </dev/null >/dev/null 2>&1 & c=$!
  ( sleep 5; kill "$c" 2>/dev/null ) >/dev/null 2>&1 & k=$!
  if wait "$c" 2>/dev/null; then p running yes; fi
  # The timer, stopped on purpose: waited for quietly, or the shell reports
  # it ("Terminated: 15").
  { kill "$k"; wait "$k"; } 2>/dev/null
elif command -v pgrep >/dev/null 2>&1 && pgrep -u "$(id -u)" -f '[a]bundio-server run' >/dev/null 2>&1; then
  p running yes
fi
# The panes the installed server has: its own children.
if command -v pgrep >/dev/null 2>&1; then
  sp=$(pgrep -u "$(id -u)" -f "$d/(current|[^/]+/abundio-server) run\$" 2>/dev/null | head -n 1)
  [ -n "$sp" ] && p panes "$(pgrep -P "$sp" 2>/dev/null | wc -l | tr -d ' ')"
fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  p systemd_user yes
fi
if command -v loginctl >/dev/null 2>&1; then
  p linger "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
fi
[ -f "$HOME/.config/systemd/user/abundio-server.service" ] && p service systemd
command -v launchctl >/dev/null 2>&1 && p launchd yes
command -v gzip >/dev/null 2>&1 && p gzip yes
[ -f "$HOME/Library/LaunchAgents/dev.abundio.server.plist" ] && p service launchd
# Agents and git as a pane would find them: on the PATH of the user's
# own interactive login shell, given 15 s in case its startup files wait.
inner='p() { printf "ABUNDIO %s=%s\n" "$1" "$2"; }
for a in "$@"; do command -v "$a" >/dev/null 2>&1 && p agent "$a"; done
command -v git >/dev/null 2>&1 && p git "$(git --version 2>/dev/null)"
p shell_done yes'
"${SHELL:-/bin/sh}" -lic "$inner" probe "$@" </dev/null 2>/dev/null &
pid=$!
( sleep 15; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
killer=$!
wait "$pid" 2>/dev/null
{ kill "$killer"; wait "$killer"; } 2>/dev/null
p done yes
"#;

/// Install a server (phase 8b), then probe as `PROBE_SCRIPT` does. Its
/// arguments: the OS and CPU the app picked the binary for, the version,
/// the binary's SHA-256 and size, then the Agents to look for. The binary
/// itself is on stdin. Nothing changes unless the Host is still that
/// platform and the bytes arrive whole; `current` moves last, atomically.
pub const INSTALL_SCRIPT: &str = r#"
set -eu
os="$1"; arch="$2"; v="$3"; want="$4"; size="$5"; kind="$6"; psize="$7"; shift 7
[ "$(uname -s) $(uname -m)" = "$os $arch" ] || { echo "the Host is no longer $os $arch" >&2; exit 2; }
umask 022
d="$HOME/.abundio-server"
mkdir -p "$d/$v"
chmod 700 "$d"
f="$d/$v/abundio-server"
# The upload: gzipped (unpacked here) or as it is; checked unpacked.
if [ "$kind" = gz ]; then
  head -c "$psize" | gzip -dc > "$f.part" || { rm -f "$f.part"; echo "the upload arrived damaged (could not unpack)" >&2; exit 3; }
else
  head -c "$psize" > "$f.part"
fi
[ "$(wc -c < "$f.part" | tr -d ' ')" = "$size" ] || { rm -f "$f.part"; echo "the upload arrived damaged (wrong size)" >&2; exit 3; }
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

/// Start the installed server unless it already answers (phase 8c), as a
/// service that comes back by itself: a `systemd --user` unit on Linux (and
/// linger, if the Host lets the user turn it on without root), else a
/// detached process that a reboot ends. Waits
/// until its socket answers; says how in `ABUNDIO started=<how>`.
///
/// `ABUNDIO_SETUP_SERVICE=detached` skips the service managers (tests).
/// The script text never spells the server's command line, so the probe's
/// `pgrep` cannot mistake this script for a server.
pub const START_SCRIPT: &str = r#"
d="$HOME/.abundio-server"
srv="$d/current"
[ -x "$srv" ] || { echo "the server is not installed" >&2; exit 5; }
alive() {
  "$srv" connect </dev/null >/dev/null 2>&1 & c=$!
  ( sleep 5; kill "$c" 2>/dev/null ) >/dev/null 2>&1 & k=$!
  r=0; wait "$c" 2>/dev/null || r=1
  { kill "$k"; wait "$k"; } 2>/dev/null || true
  return $r
}
if alive; then
  printf 'ABUNDIO started=already\n'
else
  mkdir -p "$d/data"
  chmod 700 "$d/data"
  log="$d/server.log"
  sh_="${SHELL:-/bin/sh}"
  how=detached
  u="$HOME/.config/systemd/user"
  if [ "${ABUNDIO_SETUP_SERVICE:-}" != detached ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    # Without linger systemd stops a user's services soon after their last
    # login ends, so the server would die with the app's connection: only
    # a lingering user gets the service; the rest run it detached.
    me=$(id -un)
    if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" != yes ]; then
      loginctl --no-ask-password enable-linger "$me" >/dev/null 2>&1 || true
    fi
    if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" = yes ]; then
      mkdir -p "$u"
      {
        printf '[Unit]\nDescription=Abundio server\n\n[Service]\n'
        printf 'ExecStart="%s" %s\n' "$srv" run
        printf 'Environment="SHELL=%s"\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n' "$sh_"
      } > "$u/abundio-server.service.new"
      mv -f "$u/abundio-server.service.new" "$u/abundio-server.service"
      systemctl --user daemon-reload
      systemctl --user enable abundio-server.service >/dev/null 2>&1
      systemctl --user restart abundio-server.service
      how=systemd
    elif [ -f "$u/abundio-server.service" ]; then
      # Ours from when the user lingered: a login must not start a second.
      systemctl --user disable --now abundio-server.service >/dev/null 2>&1 || true
      rm -f "$u/abundio-server.service"
      systemctl --user daemon-reload || true
    fi
  fi
  # A Mac: a LaunchAgent in the user's login session, which starts the
  # server at login and again whenever it stops. Loading one needs that
  # session (someone logged in on the Mac's screen); without it, detached.
  if [ "$how" = detached ] && [ "${ABUNDIO_SETUP_SERVICE:-}" != detached ] && [ "$(uname -s)" = Darwin ] && command -v launchctl >/dev/null 2>&1; then
    a="$HOME/Library/LaunchAgents"
    mkdir -p "$a"
    pl="$a/dev.abundio.server.plist"
    x() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
    {
      printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      printf '<plist version="1.0"><dict>\n<key>Label</key><string>dev.abundio.server</string>\n'
      printf '<key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>\n' "$(x "$srv")" run
      printf '<key>EnvironmentVariables</key><dict><key>SHELL</key><string>%s</string></dict>\n' "$(x "$sh_")"
      printf '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>2</integer>\n'
      printf '<key>StandardOutPath</key><string>%s</string>\n<key>StandardErrorPath</key><string>%s</string>\n' "$(x "$log")" "$(x "$log")"
      printf '</dict></plist>\n'
    } > "$pl.new"
    mv -f "$pl.new" "$pl"
    uid=$(id -u)
    launchctl bootout "gui/$uid/dev.abundio.server" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$uid" "$pl" >/dev/null 2>&1; then
      how=launchd
    else
      # Nobody logged in on the Mac: no LaunchAgent, rather than one that
      # never loads.
      rm -f "$pl"
      printf 'ABUNDIO launchd_refused=yes\n'
    fi
  fi
  if [ "$how" = detached ]; then
    # Not `nohup`: macOS's refuses to run without a console (the tests run
    # this script on the developer's Mac).
    if command -v setsid >/dev/null 2>&1; then
      ( trap '' HUP; exec setsid "$srv" run ) >>"$log" 2>&1 </dev/null &
    else
      ( trap '' HUP; exec "$srv" run ) >>"$log" 2>&1 </dev/null &
    fi
  fi
  i=0
  until alive; do
    i=$((i + 1))
    if [ "$i" -ge 15 ]; then
      echo "the server did not start:" >&2
      tail -n 3 "$log" >&2 2>/dev/null || true
      exit 6
    fi
    sleep 1
  done
  printf 'ABUNDIO started=%s\n' "$how"
fi
"#;

/// Stop the server (phase 8d): its service if the app set one up, then any
/// installed server still running, politely, then not. Only servers run
/// from `~/.abundio-server` with no options: never one started by hand
/// from elsewhere, or with `--data-dir` (tests).
pub const STOP_SCRIPT: &str = r#"
sd="$HOME/.abundio-server"
unit="$HOME/.config/systemd/user/abundio-server.service"
if [ -f "$unit" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop abundio-server.service >/dev/null 2>&1 || true
fi
# A Mac's LaunchAgent restarts the server whenever it stops: unloaded
# first (Start loads it again).
agent="$HOME/Library/LaunchAgents/dev.abundio.server.plist"
if [ -f "$agent" ] && command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/dev.abundio.server" >/dev/null 2>&1 || true
fi
servers() { pgrep -u "$(id -u)" -f "$sd/(current|[^/]+/abundio-server) run\$" 2>/dev/null || true; }
left=$(servers)
if [ -n "$left" ]; then
  kill $left 2>/dev/null || true
  n=0
  while [ -n "$(servers)" ] && [ "$n" -lt 10 ]; do sleep 1; n=$((n + 1)); done
  left=$(servers)
  if [ -n "$left" ]; then kill -9 $left 2>/dev/null || true; sleep 1; fi
fi
printf 'ABUNDIO stopped=yes\n'
"#;

/// Remove the server from a Host (phase 8d): stop it, drop the service the
/// app set up, delete `~/.abundio-server` with its data.
pub const UNINSTALL_SCRIPT: &str = r#"
[ -n "$HOME" ] && [ "$HOME" != / ] || { echo "no home folder" >&2; exit 2; }
if [ -f "$unit" ]; then
  systemctl --user disable abundio-server.service >/dev/null 2>&1 || true
  rm -f "$unit"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "$agent"
rm -rf "$HOME/.abundio-server"
printf 'ABUNDIO removed=yes\n'
"#;

/// Install, stop whatever server runs, start the new one, then probe, in
/// one ssh (one password prompt).
pub fn install_then_probe() -> String {
    format!("{INSTALL_SCRIPT}\n{STOP_SCRIPT}\n{START_SCRIPT}\nset +eu\n{PROBE_SCRIPT}")
}

/// Start (or, with `restart`, stop and start), then probe, in one ssh.
/// Its arguments: the Agents to look for.
pub fn start_then_probe(restart: bool) -> String {
    let stop = if restart { STOP_SCRIPT } else { "" };
    format!("set -eu\n{stop}\n{START_SCRIPT}\nset +eu\n{PROBE_SCRIPT}")
}

/// Take the service Abundio set up away (systemd `--user` unit or a Mac's
/// LaunchAgent), then run the server detached, so the Host keeps working
/// until it reboots; then probe, in one ssh.
pub fn remove_service_then_probe() -> String {
    format!("set -eu\n{STOP_SCRIPT}\n{REMOVE_SERVICE_SCRIPT}\nABUNDIO_SETUP_SERVICE=detached\n{START_SCRIPT}\nset +eu\n{PROBE_SCRIPT}")
}

/// The service files Abundio wrote, gone (after `STOP_SCRIPT`, whose
/// `$unit` and `$agent` it uses).
pub const REMOVE_SERVICE_SCRIPT: &str = r#"
if [ -f "$unit" ]; then
  systemctl --user disable abundio-server.service >/dev/null 2>&1 || true
  rm -f "$unit"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
rm -f "$agent"
"#;

/// Stop the server and remove it, in one ssh.
pub fn uninstall() -> String {
    format!("set -eu\n{STOP_SCRIPT}\n{UNINSTALL_SCRIPT}")
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
    /// Its SHA-256 (development builds tell a rebuilt server by it).
    pub current_sha: Option<String>,
    pub running: bool,
    pub systemd_user: bool,
    /// `None`: no `loginctl`.
    pub linger: Option<bool>,
    /// `launchctl` is there (a Mac).
    pub launchd: bool,
    /// `gzip` is there: Install uploads the server gzipped.
    pub gzip: bool,
    /// A start found nobody logged in on the Mac, so no LaunchAgent.
    pub launchd_refused: bool,
    /// `systemd` or `launchd`: the service the app wrote.
    pub service: Option<String>,
    pub agents: Vec<String>,
    pub git: Option<String>,
    /// The login shell answered in time.
    pub shell_answered: bool,
    /// The whole script ran.
    pub complete: bool,
    /// The version an install just put in place.
    pub installed_now: Option<String>,
    /// How a start just ran it: `systemd`, `detached`, or
    /// `already` (it was running).
    pub started: Option<String>,
    /// The panes (shells, Agents) a running server has.
    pub panes: Option<u32>,
    /// The uninstall finished.
    pub removed: bool,
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
            "current_sha" if !value.is_empty() => p.current_sha = Some(value),
            "running" => p.running = value == "yes",
            "systemd_user" => p.systemd_user = value == "yes",
            "linger" => p.linger = Some(value == "yes"),
            "service" => p.service = Some(value),
            "launchd" => p.launchd = value == "yes",
            "gzip" => p.gzip = value == "yes",
            "launchd_refused" => p.launchd_refused = value == "yes",
            "agent" if !p.agents.contains(&value) => p.agents.push(value),
            "git" => p.git = Some(value),
            "shell_done" => p.shell_answered = true,
            "done" => p.complete = true,
            "install_done" => p.installed_now = Some(value),
            "started" => p.started = Some(value),
            "panes" => p.panes = value.parse().ok(),
            "removed" => p.removed = value == "yes",
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
        // A Mac: one binary for both chips. Abundio installs and starts it
        // there but never sets up a service; the user keeps it running
        // (ADR-0062, phase 13).
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
    /// `ok`, `warn` (works, with a gap), `error` (blocks using the Host) or
    /// `info` (worth knowing, nothing to fix).
    pub state: &'static str,
    /// What fixes it, in words.
    pub fix: Option<String>,
    /// The button that fixes it: `install`, `update`, `start`, `service`
    /// (restart a server running by itself as a service), `unservice`
    /// (remove that service, the server running on detached).
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
            item("running", "error", "Not running")
                .fix(match (p.os.as_str(), p.service.as_deref()) {
                    ("Darwin", _) => "Start runs it as a LaunchAgent, so it comes back by itself (that needs you logged in on the Mac).",
                    _ => "Start runs it as a service, so it comes back by itself.",
                })
                .action("start")
        });
    }
    out.push(reboot_item(p, installed));
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
    let mac = p.os == "Darwin";
    if mac {
        out.push(
            item("mac", "info", "On a Mac, panes have the limits of an SSH login")
                .fix("Agents that keep their login in the Keychain may look signed out while the server runs without its LaunchAgent. Desktop, Documents and Downloads need System Settings ▸ General ▸ Sharing ▸ Remote Login ⓘ ▸ Allow full disk access for remote users, or a yes to macOS's prompt on the Mac's screen."),
        );
    }
    out
}

/// A development build's checklist: the Host runs this version but not this
/// build's server (`local_sha`), so the server line offers Update. Release
/// builds never need it: one version is one binary.
pub fn mark_rebuilt_server(items: &mut [CheckItem], p: &Probe, version: &str, local_sha: &str) {
    if p.current.as_deref() != Some(version) || p.current_sha.as_deref().is_none_or(|s| s == local_sha) {
        return;
    }
    if let Some(i) = items.iter_mut().find(|i| i.id == "server") {
        *i = item("server", "warn", format!("Server {version} installed, from another development build"))
            .fix("Update installs the server built next to this app.")
            .action("update");
    }
}

fn reboot_item(p: &Probe, installed: bool) -> CheckItem {
    let linger = format!("Run once on the Host: sudo loginctl enable-linger {}", p.user);
    // A server running by itself that a service could take over.
    let movable = installed && p.running;
    match (p.os.as_str(), p.service.as_deref()) {
        ("Linux", Some("systemd")) if p.linger == Some(true) => {
            item("reboot", "ok", "Comes back after a reboot").action("unservice")
        }
        ("Linux", Some("systemd")) => item("reboot", "warn", "Stops soon after you log out of the Host")
            .fix(linger)
            .action("unservice"),
        // Start runs it as a service only for a lingering user: without
        // linger systemd would stop it with the app's connection.
        ("Linux", _) if p.systemd_user && p.linger == Some(true) => {
            let i = item("reboot", "warn", "Not set up to come back after a reboot");
            if movable {
                i.fix("Restarts it as a systemd user service.").action("service")
            } else {
                i.fix("Start sets it up as a systemd user service.")
            }
        }
        ("Linux", _) if p.systemd_user => item("reboot", "warn", "Won't come back after a reboot")
            .fix(format!("{linger}, then Check again to set it up as a systemd user service.")),
        ("Linux", _) => item("reboot", "warn", "Won't come back after a reboot (no systemd --user)")
            .fix("Start it again from here after a reboot."),
        // A Mac: a LaunchAgent in the user's login session (phase 13).
        ("Darwin", Some("launchd")) => {
            item("reboot", "ok", "Comes back when you log in on the Mac").action("unservice")
        }
        ("Darwin", _) if movable && p.launchd => item("reboot", "warn", "Not set up to come back after a reboot")
            .fix("Restarts it as a LaunchAgent; that needs you logged in on the Mac.")
            .action("service"),
        ("Darwin", _) if p.launchd_refused => item("reboot", "warn", "Won't come back after a reboot")
            .fix("Nobody was logged in on the Mac, so it runs without a LaunchAgent. Log in there, then Start or Check again."),
        ("Darwin", _) => item("reboot", "warn", "Won't come back after a reboot")
            .fix("Start sets it up as a LaunchAgent while you are logged in on the Mac."),
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

    const LINUX: &str = "Welcome to box!\nABUNDIO os=Linux\nABUNDIO arch=x86_64\nABUNDIO user=dev\nABUNDIO home=/home/dev\nABUNDIO home_writable=yes\nABUNDIO installed=3.0.0\nABUNDIO installed=3.1.0\nABUNDIO current=3.1.0\nABUNDIO running=yes\nABUNDIO systemd_user=yes\nABUNDIO linger=no\nABUNDIO service=systemd\nlast login: never\nABUNDIO agent=claude\nABUNDIO agent=codex\nABUNDIO git=git version 2.43.0\nABUNDIO shell_done=yes\nABUNDIO done=yes\n";

    #[test]
    fn reads_what_the_probe_said_and_nothing_else() {
        let p = parse_probe(LINUX);
        assert_eq!((p.os.as_str(), p.arch.as_str(), p.user.as_str()), ("Linux", "x86_64", "dev"));
        assert_eq!(p.installed, ["3.0.0", "3.1.0"]);
        assert_eq!(p.current.as_deref(), Some("3.1.0"));
        assert!(p.running && p.systemd_user && p.home_writable && p.complete && p.shell_answered);
        assert_eq!(p.linger, Some(false));
        assert_eq!(p.agents, ["claude", "codex"]);
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
        // GitHub is this computer's (New task's issues): no gh check here.
        assert!(!list.iter().any(|i| i.id == "gh"));
        // Another app version: Update.
        let list = checklist(&p, "3.2.0");
        let server = list.iter().find(|i| i.id == "server").unwrap();
        assert_eq!((server.state, server.action), ("error", Some("update")));
        assert!(!list.iter().any(|i| i.id == "running"));
        // A lingering user's server running by itself: a service can take it.
        let loose = Probe { linger: Some(true), service: None, ..p.clone() };
        let reboot = checklist(&loose, "3.1.0").into_iter().find(|i| i.id == "reboot").unwrap();
        assert_eq!(reboot.action, Some("service"));
        let stopped = Probe { running: false, ..loose };
        assert_eq!(checklist(&stopped, "3.1.0").iter().find(|i| i.id == "reboot").unwrap().action, None);
        // A development build whose server was rebuilt: Update.
        let built = Probe { current_sha: Some("aa".into()), ..p.clone() };
        let mut list = checklist(&built, "3.1.0");
        mark_rebuilt_server(&mut list, &built, "3.1.0", "bb");
        assert_eq!(list.iter().find(|i| i.id == "server").unwrap().action, Some("update"));
        let mut same = checklist(&built, "3.1.0");
        mark_rebuilt_server(&mut same, &built, "3.1.0", "aa");
        assert_eq!(same.iter().find(|i| i.id == "server").unwrap().action, None);
        // Nothing installed: Install.
        let bare = Probe { current: None, installed: vec![], ..p.clone() };
        assert_eq!(checklist(&bare, "3.1.0").iter().find(|i| i.id == "server").unwrap().action, Some("install"));
        // A platform with no server: nothing to install.
        let odd = Probe { os: "FreeBSD".into(), arch: "amd64".into(), current: None, ..p };
        let list = checklist(&odd, "3.1.0");
        assert_eq!(list.iter().find(|i| i.id == "platform").unwrap().state, "error");
        assert_eq!(list.iter().find(|i| i.id == "server").unwrap().action, None);
    }

    /// Phase 13: a Mac's server runs as a LaunchAgent Abundio sets up, which
    /// needs someone logged in on the Mac.
    #[test]
    fn a_macs_reboot_line_follows_its_launch_agent() {
        let mac = "ABUNDIO os=Darwin\nABUNDIO arch=arm64\nABUNDIO user=me\nABUNDIO home=/Users/me\nABUNDIO home_writable=yes\nABUNDIO current=3.1.0\nABUNDIO running=yes\nABUNDIO launchd=yes\nABUNDIO done=yes\n";
        let reboot = |text: &str| checklist(&parse_probe(text), "3.1.0").into_iter().find(|i| i.id == "reboot").unwrap();
        // Running by itself: a LaunchAgent can take it over.
        let loose = reboot(mac);
        assert_eq!((loose.state, loose.action), ("warn", Some("service")));
        assert_eq!(reboot(&format!("{mac}ABUNDIO service=launchd\n")).state, "ok");
        // Nobody was logged in: says so.
        let refused = reboot(&format!("{mac}ABUNDIO launchd_refused=yes\n").replace("running=yes", "running=no"));
        assert!(refused.fix.unwrap().contains("Nobody was logged in"));
        assert_eq!(platform("Darwin", "arm64"), Ok("macos-universal"));
    }

    /// The service Abundio set up can be taken away on every platform; the
    /// server then runs on detached.
    #[test]
    fn a_mac_notes_the_limits_of_an_ssh_login() {
        let mac = parse_probe("ABUNDIO os=Darwin\nABUNDIO arch=arm64\nABUNDIO done=yes\n");
        let list = checklist(&mac, "3.1.0");
        let note = list.iter().find(|i| i.id == "mac").unwrap();
        assert_eq!(note.state, "info");
        assert!(note.fix.as_deref().unwrap().contains("Full Disk Access") || note.fix.as_deref().unwrap().contains("full disk access"));
        assert!(!checklist(&parse_probe(LINUX), "3.1.0").iter().any(|i| i.id == "mac"));
    }

    #[test]
    fn a_service_abundio_set_up_can_be_removed() {
        let linux = parse_probe(&LINUX.replace("linger=no", "linger=yes"));
        let reboot = |p: &Probe| checklist(p, "3.1.0").into_iter().find(|i| i.id == "reboot").unwrap();
        assert_eq!(reboot(&linux).action, Some("unservice"));
        assert_eq!(reboot(&parse_probe(LINUX)).action, Some("unservice"));
        let mac = parse_probe("ABUNDIO os=Darwin\nABUNDIO arch=arm64\nABUNDIO current=3.1.0\nABUNDIO running=yes\nABUNDIO launchd=yes\nABUNDIO service=launchd\nABUNDIO done=yes\n");
        assert_eq!(reboot(&mac).action, Some("unservice"));
        let script = remove_service_then_probe();
        assert!(script.find("rm -f \"$agent\"").unwrap() < script.find("ABUNDIO_SETUP_SERVICE=detached").unwrap());
        assert!(script.contains("systemctl --user disable abundio-server.service"));
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
        assert_eq!(platform("Darwin", "x86_64"), Ok("macos-universal"));
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
        let send = |os: &str, sha: &str, kind: &str, bytes: Vec<u8>| {
            let mut c = std::process::Command::new("/bin/sh");
            let script = install_then_probe();
            let psize = bytes.len().to_string();
            c.args(["-c", &script, "abundio-setup", os, &arch, "9.9.9", sha, &binary.len().to_string(), kind, &psize])
                .env("HOME", home.path());
            run(c, Box::new(std::io::Cursor::new(bytes)), std::time::Duration::from_secs(10))
        };
        let install = |os: &str, sha: &str, bytes: Vec<u8>| send(os, sha, "raw", bytes);
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
        // Gzipped, as the app sends it (phase 15): unpacked on the Host.
        let gz = {
            use std::io::Write;
            let mut c = std::process::Command::new("gzip")
                .arg("-c")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            c.stdin.take().unwrap().write_all(&binary).unwrap();
            c.wait_with_output().unwrap().stdout
        };
        let out = send(&os, &sha, "gz", gz.clone()).unwrap();
        assert_eq!(parse_probe(&out).installed_now.as_deref(), Some("9.9.9"));
        // Not gzip at all: refused, nothing changed.
        assert!(send(&os, &sha, "gz", binary.clone()).unwrap_err().contains("damaged"));
        let v = std::process::Command::new(&current).arg("version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&v.stdout).trim(), "abundio-server 9.9.9");
        assert_eq!(std::fs::read_link(&current).unwrap(), std::path::Path::new("9.9.9/abundio-server"));
    }

    /// The start, restart and uninstall scripts, run here with a fake
    /// server and no service manager: it starts the server detached, waits
    /// until it answers, leaves a running one alone, restarts it on asking,
    /// and removes it all.
    #[cfg(unix)]
    #[test]
    fn starts_restarts_and_removes_the_server() {
        let home = tempfile::tempdir().unwrap();
        let d = home.path().join(".abundio-server");
        std::fs::create_dir_all(d.join("9.9.9")).unwrap();
        let fake = d.join("9.9.9/abundio-server");
        std::fs::write(
            &fake,
            r#"#!/bin/sh
d="$HOME/.abundio-server/data"
case "$1" in
  version) echo abundio-server 9.9.9;;
  connect) [ -f "$d/up" ];;
  run)
    echo $$ > "$d/pid"
    trap 'rm -f "$d/up"; kill $k; exit 0' TERM
    sleep 1; touch "$d/up"
    sleep 30 & k=$!
    wait;;
esac
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("9.9.9/abundio-server", d.join("current")).unwrap();
        let sh = |script: String| {
            let mut c = std::process::Command::new("/bin/sh");
            c.args(["-c", &script, "abundio-setup"])
                .env("HOME", home.path())
                .env("ABUNDIO_SETUP_SERVICE", "detached");
            run(c, Box::new(std::io::empty()), std::time::Duration::from_secs(40))
        };
        let pid = || std::fs::read_to_string(d.join("data/pid")).unwrap();
        let p = parse_probe(&sh(start_then_probe(false)).unwrap());
        assert_eq!(p.started.as_deref(), Some("detached"));
        assert!(p.running);
        assert_eq!(p.panes, Some(1), "the fake server's one child");
        let first = pid();
        // Running already: left alone.
        let again = parse_probe(&sh(start_then_probe(false)).unwrap());
        assert_eq!(again.started.as_deref(), Some("already"));
        assert_eq!(pid(), first);
        // A restart stops it and starts another.
        let restarted = parse_probe(&sh(start_then_probe(true)).unwrap());
        assert_eq!(restarted.started.as_deref(), Some("detached"));
        assert_ne!(pid(), first);
        // The tests start it detached (ABUNDIO_SETUP_SERVICE): never a
        // LaunchAgent in the developer's real login session.
        assert!(!home.path().join("Library/LaunchAgents/dev.abundio.server.plist").exists());
        // Uninstall: stopped, and the folder is gone.
        let last = pid();
        assert!(parse_probe(&sh(uninstall()).unwrap()).removed);
        assert!(!d.exists());
        let alive = std::process::Command::new("kill").args(["-0", last.trim()]).status().unwrap();
        assert!(!alive.success(), "the server was stopped");
        // Not installed: says so.
        assert!(sh(start_then_probe(false)).unwrap_err().contains("not installed"));
    }

    /// The real script, run here: it answers every question.
    #[cfg(unix)]
    #[test]
    fn the_script_runs_on_this_computer() {
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", PROBE_SCRIPT, "probe", "sh", "no-such-agent-xyz"])
            .env("SHELL", "/bin/sh")
            .output()
            .unwrap();
        let p = parse_probe(&String::from_utf8_lossy(&out.stdout));
        assert!(p.complete, "{}", String::from_utf8_lossy(&out.stderr));
        assert!(!p.os.is_empty() && !p.home.is_empty());
        assert_eq!(p.agents, ["sh"]);
    }
}
