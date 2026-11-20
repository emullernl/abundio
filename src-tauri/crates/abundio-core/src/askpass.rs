//! SSH prompts answered in an Abundio dialog (docs/plans/remote-hosts.md
//! phase 7d, ADR-0062): the user's `ssh` runs with `SSH_ASKPASS` pointing at
//! a small script that hands each prompt (a password, a key's passphrase, a
//! 2FA code, a new host key to trust) to the app over its loopback hook
//! server and prints the answer back to ssh.
//!
//! Only the `ssh` that connects may ask: each interactive connect gets a
//! one-time token, put in that process's environment alone. The hook token
//! every pane has (`ABUNDIO_HOOK_TOKEN`) is never enough, or a program in a
//! pane could raise a password dialog of its own.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// How long a prompt waits for the user.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

const SCRIPT: &str = r#"#!/bin/sh
# Abundio's SSH prompt helper (SSH_ASKPASS). ssh runs it with the prompt as
# its argument; it asks the Abundio app, which shows the prompt in a dialog,
# and prints the answer. Rewritten on every start; edits are lost.
[ -n "$ABUNDIO_ASKPASS_URL" ] && [ -n "$ABUNDIO_ASKPASS_TOKEN" ] || exit 1
exec curl -sf --max-time 310 -X POST \
  -H "X-Abundio-Askpass-Token: $ABUNDIO_ASKPASS_TOKEN" \
  -H "X-Abundio-Askpass-Kind: ${SSH_ASKPASS_PROMPT:-}" \
  --data-binary "$1" "$ABUNDIO_ASKPASS_URL"
"#;

/// Write the helper into `dir` (private to the user) and return its path.
pub fn write_script(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("abundio-askpass");
    std::fs::write(&path, SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

/// One prompt, as the dialog shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub host: String,
    /// What ssh asked, as it wrote it.
    pub text: String,
    /// `secret` (typed, hidden), `confirm` (yes or no: a new host key), or
    /// `info` (only to acknowledge).
    pub kind: &'static str,
}

/// What kind of answer a prompt wants.
pub fn kind_of(text: &str, ssh_kind: &str) -> &'static str {
    let lower = text.to_lowercase();
    if ssh_kind == "confirm" || lower.contains("(yes/no") {
        "confirm"
    } else if ssh_kind == "none" {
        "info"
    } else {
        "secret"
    }
}

/// The tokens handed out and the prompts waiting for an answer.
#[derive(Default)]
pub struct Askpass {
    /// Token → the Host its ssh connects to.
    tokens: Mutex<HashMap<String, String>>,
    waiting: Mutex<HashMap<String, crossbeam_channel::Sender<Option<String>>>>,
}

impl Askpass {
    /// A token for one connect to `host`; revoke it when the connect ends.
    pub fn issue(&self, host: &str) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.tokens.lock().unwrap().insert(token.clone(), host.to_string());
        token
    }

    pub fn revoke(&self, token: &str) {
        self.tokens.lock().unwrap().remove(token);
    }

    /// The environment of an interactive `ssh`: the helper, how to reach the
    /// app, and its token. `SSH_ASKPASS_REQUIRE=force` makes ssh use the
    /// helper even with a terminal around; `DISPLAY` is what older ssh
    /// versions look for before they use it at all.
    pub fn env(script: &Path, port: u16, token: &str) -> Vec<(String, String)> {
        vec![
            ("SSH_ASKPASS".into(), script.to_string_lossy().into_owned()),
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            ("DISPLAY".into(), std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into())),
            ("ABUNDIO_ASKPASS_URL".into(), format!("http://127.0.0.1:{port}/askpass")),
            ("ABUNDIO_ASKPASS_TOKEN".into(), token.to_string()),
        ]
    }

    /// The user's answer to prompt `id` (`None`: cancelled).
    pub fn answer(&self, id: &str, answer: Option<String>) -> bool {
        match self.waiting.lock().unwrap().remove(id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// Serve one `/askpass` request: check its token, `show` the prompt, and
    /// wait for the answer. Runs on its own thread.
    pub fn serve(&self, mut request: tiny_http::Request, show: &dyn Fn(&Prompt) -> bool) {
        let header = |name: &'static str| {
            request
                .headers()
                .iter()
                .find(|h| h.field.equiv(name))
                .map(|h| h.value.as_str().to_string())
                .unwrap_or_default()
        };
        let token = header("X-Abundio-Askpass-Token");
        let ssh_kind = header("X-Abundio-Askpass-Kind");
        let host = self.tokens.lock().unwrap().get(&token).cloned();
        let Some(host) = host.filter(|_| !token.is_empty()) else {
            let _ = request.respond(tiny_http::Response::empty(403));
            return;
        };
        let mut body = String::new();
        let _ = request.as_reader().take(64 * 1024).read_to_string(&mut body);
        let prompt = Prompt {
            id: uuid::Uuid::new_v4().to_string(),
            host,
            kind: kind_of(&body, &ssh_kind),
            text: body,
        };
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.waiting.lock().unwrap().insert(prompt.id.clone(), tx);
        let answer = if show(&prompt) { rx.recv_timeout(ANSWER_TIMEOUT).ok().flatten() } else { None };
        self.waiting.lock().unwrap().remove(&prompt.id);
        let _ = match answer {
            Some(a) => request.respond(tiny_http::Response::from_string(a)),
            None => request.respond(tiny_http::Response::empty(403)),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_host_key_question_from_a_password() {
        let host_key = "The authenticity of host 'box (10.0.0.2)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?";
        assert_eq!(kind_of(host_key, ""), "confirm");
        assert_eq!(kind_of("me@box's password:", ""), "secret");
        assert_eq!(kind_of("Enter passphrase for key '/Users/me/.ssh/id_ed25519':", ""), "secret");
        assert_eq!(kind_of("Allow use of key?", "confirm"), "confirm");
        assert_eq!(kind_of("Notice", "none"), "info");
    }

    #[test]
    fn the_helper_only_runs_with_its_address_and_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_script(dir.path()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("X-Abundio-Askpass-Token"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
            // Without the app's variables it answers nothing.
            let out = std::process::Command::new(&path).arg("password:").env_clear().output().unwrap();
            assert!(!out.status.success());
            assert!(out.stdout.is_empty());
        }
    }

    #[test]
    fn a_token_is_for_one_connect() {
        let a = Askpass::default();
        let t = a.issue("box");
        assert_eq!(a.tokens.lock().unwrap().get(&t).map(String::as_str), Some("box"));
        a.revoke(&t);
        assert!(a.tokens.lock().unwrap().is_empty());
        let env = Askpass::env(Path::new("/x/abundio-askpass"), 4321, &t);
        assert!(env.contains(&("ABUNDIO_ASKPASS_URL".into(), "http://127.0.0.1:4321/askpass".into())));
        assert!(env.contains(&("SSH_ASKPASS_REQUIRE".into(), "force".into())));
    }

    /// The helper as ssh runs it: the prompt reaches the app, the answer
    /// comes back on its stdout; a wrong token is refused.
    #[cfg(unix)]
    #[test]
    fn the_helper_carries_a_prompt_to_the_app_and_its_answer_back() {
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let script = write_script(dir.path()).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let askpass = Arc::new(Askpass::default());
        let token = askpass.issue("build-box");
        let shown = Arc::new(Mutex::new(Vec::<Prompt>::new()));
        {
            let (askpass, shown) = (askpass.clone(), shown.clone());
            std::thread::spawn(move || {
                for request in server.incoming_requests() {
                    let (askpass, shown) = (askpass.clone(), shown.clone());
                    std::thread::spawn(move || {
                        let a = askpass.clone();
                        askpass.serve(request, &|p| {
                            shown.lock().unwrap().push(p.clone());
                            let (a, id) = (a.clone(), p.id.clone());
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(20));
                                a.answer(&id, Some("hunter2".into()));
                            });
                            true
                        });
                    });
                }
            });
        }
        let run = |token: &str| {
            std::process::Command::new(&script)
                .arg("me@build-box's password:")
                .envs(Askpass::env(&script, port, token))
                .output()
                .unwrap()
        };
        let out = run(&token);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hunter2");
        let seen = shown.lock().unwrap().clone();
        assert_eq!((seen[0].host.as_str(), seen[0].kind), ("build-box", "secret"));
        assert_eq!(seen[0].text, "me@build-box's password:");
        // A token the app never issued (the hook token a pane has, say).
        let refused = run("not-a-token");
        assert!(!refused.status.success());
        assert!(refused.stdout.is_empty());
        assert_eq!(shown.lock().unwrap().len(), 1);
    }
}
