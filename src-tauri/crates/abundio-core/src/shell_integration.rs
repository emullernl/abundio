//! **Shell integration**, read where the PTY runs (docs/plans/remote-hosts.md
//! phase 6d-4): the shell reports each command's start (with its text), its
//! end (with its exit code) and its folder on the `7770` channel
//! (`ESC ] 7770 ; … BEL`, written by the wrapper scripts in
//! `pty_manager.rs`). Reading them here keeps a Host's status with no
//! Window: a shell command's Working and Error, and an Agent typed at the
//! prompt entering and leaving agent mode (`StatusStore::shell_commands`).
//!
//! [`Parser`] finds the same commands as the Window's `ShellIntegrationParser`
//! (`src/lib/shellIntegration.ts`), across any chunking; [`match_agent`] is
//! `matchTitleToAgent` (`src/lib/agents.ts`). Both are held to the Window's
//! by `fixtures/shellIntegration.json`. The Window still strips the
//! sequences before xterm.js draws, and keeps the running command and folder.

use std::collections::HashSet;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const PREFIX: &[u8] = b"]7770;";

/// Held bytes past this are a misframed sequence that will never end: given
/// up on, as the Window does (`MAX_PARTIAL`).
const MAX_PARTIAL: usize = 16 * 1024;

/// One shell-integration report (`ShellCommand`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShellCommand {
    CommandStart {
        #[serde(rename = "commandText", default, skip_serializing_if = "Option::is_none")]
        command_text: Option<String>,
    },
    CommandEnd {
        #[serde(rename = "exitCode", default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    #[serde(rename = "cwd_change")]
    Cwd {
        #[serde(default)]
        path: String,
    },
}

/// A PTY's reader of the channel: a sequence split across reads is held
/// until its end arrives.
#[derive(Default)]
pub struct Parser {
    residual: Vec<u8>,
}

impl Parser {
    pub fn parse(&mut self, data: &[u8]) -> Vec<ShellCommand> {
        if self.residual.is_empty() && !data.contains(&ESC) {
            return Vec::new();
        }
        let mut input = std::mem::take(&mut self.residual);
        input.extend_from_slice(data);
        let mut commands = Vec::new();
        let mut i = 0;
        // Hold from `i` on for the next read, unless that is too much.
        let hold = |i: usize, residual: &mut Vec<u8>, input: &[u8]| -> bool {
            if input.len() - i > MAX_PARTIAL {
                return false;
            }
            *residual = input[i..].to_vec();
            true
        };
        while i < input.len() {
            if input[i] != ESC {
                i += 1;
                continue;
            }
            let after = &input[i + 1..];
            let n = after.len().min(PREFIX.len());
            if after[..n] != PREFIX[..n] {
                // Some other escape sequence.
                i += 1;
                continue;
            }
            if n < PREFIX.len() {
                // The prefix so far matches, and the read ends inside it.
                if hold(i, &mut self.residual, &input) {
                    break;
                }
                i += 1;
                continue;
            }
            let start = i + 1 + PREFIX.len();
            let Some(bel) = input[start..].iter().position(|&b| b == BEL).map(|p| start + p) else {
                if hold(i, &mut self.residual, &input) {
                    break;
                }
                i += 1;
                continue;
            };
            let payload = String::from_utf8_lossy(&input[start..bel]);
            if let Some(c) = read_payload(&payload) {
                commands.push(c);
            }
            i = bel + 1;
        }
        commands
    }
}

fn read_payload(payload: &str) -> Option<ShellCommand> {
    if payload == "command_start" {
        return Some(ShellCommand::CommandStart { command_text: None });
    }
    if let Some(text) = payload.strip_prefix("command_start;") {
        let command_text = (!text.is_empty()).then(|| text.to_string());
        return Some(ShellCommand::CommandStart { command_text });
    }
    if let Some(code) = payload.strip_prefix("command_end;") {
        return Some(ShellCommand::CommandEnd { exit_code: parse_int(code) });
    }
    payload
        .strip_prefix("cwd;")
        .map(|path| ShellCommand::Cwd { path: path.to_string() })
}

/// JavaScript's `parseInt(s, 10)`: leading space, a sign, then the digits
/// up to the first that is not one; `None` when there are none.
fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (negative, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n: i64 = digits.parse().unwrap_or(i64::MAX);
    Some(if negative { -n } else { n })
}

/// One Agent a typed command can start (`CodingAgent`'s id, command and
/// enabled flag).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCommand {
    pub id: String,
    pub command: String,
    pub enabled: bool,
}

/// `matchTitleToAgent`: the first enabled Agent whose command appears in the
/// command line as a word (after the start, a slash or a space; before the
/// end or a space), ignoring case.
pub fn match_agent<'a>(text: &str, agents: &'a [AgentCommand]) -> Option<&'a AgentCommand> {
    if text.is_empty() {
        return None;
    }
    let lower = text.to_lowercase();
    agents.iter().filter(|a| a.enabled).find(|a| has_word(&lower, &a.command.to_lowercase()))
}

/// Whether `word` appears in `text` with a boundary on each side, at any
/// position (as a regular expression would try each one).
fn has_word(text: &str, word: &str) -> bool {
    let mut from = 0;
    while let Some(p) = text[from..].find(word) {
        let at = from + p;
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].chars().next();
        let starts = before.is_none_or(|c| c == '/' || c == '\\' || c.is_whitespace());
        if starts && after.is_none_or(char::is_whitespace) {
            return true;
        }
        let Some(c) = text[at..].chars().next() else { return false };
        from = at + c.len_utf8();
    }
    false
}

/// The built-in Agents (`BUILTIN_AGENTS` in `src/lib/agents.ts`), what a
/// Host knows before any Window has said otherwise.
pub fn builtin_agents() -> Vec<AgentCommand> {
    ["claude", "copilot", "gemini", "codex", "opencode", "qwen", "kimi", "grok", "vibe"]
        .iter()
        .map(|id| AgentCommand { id: id.to_string(), command: id.to_string(), enabled: true })
        .collect()
}

/// The Agents a typed command is matched against: the built-ins until a
/// Window reports the user's list (custom Agents, disabled ones). Also what
/// the **Watch offer** needs to know (docs/plans/watch-offer.md): whether
/// hooks are on, which Agents the user declined (*Never*, Host settings) and
/// which they put off until the next start (*Not now*, memory only).
pub struct AgentCommands {
    list: RwLock<Vec<AgentCommand>>,
    offers: RwLock<OfferState>,
}

#[derive(Debug, Clone, Default)]
struct OfferState {
    hooks_enabled: bool,
    declined: HashSet<String>,
    snoozed: HashSet<String>,
    /// Agents whose hooks were found written (or written) since the list or
    /// the settings last changed: a typed start of one needs no disk work.
    provisioned: HashSet<String>,
}

/// Commands that run the next word as the command (`env FOO=1 codex`,
/// `npx codex`): the Agent may follow them.
const WRAPPERS: &[&str] = &["env", "npx", "bunx", "pnpx", "exec", "command", "nohup", "time", "sudo"];

/// The command a typed line runs, lowercased: its first word after any
/// `NAME=value` assignments, wrappers and their options, without its folder
/// (`/opt/bin/codex`, `@openai/codex`). Only a line whose command *is* the
/// Agent starts it: `brew install codex` or `git commit -m "codex"` do not,
/// though they name it.
pub fn command_word(text: &str) -> Option<String> {
    let mut after_wrapper = false;
    for word in text.split_whitespace() {
        let is_assignment = word.contains('=') && !word.starts_with('-') && !word.starts_with('=');
        if is_assignment || (after_wrapper && word.starts_with('-')) {
            continue;
        }
        let lower = word.to_lowercase();
        let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower).to_string();
        if WRAPPERS.contains(&base.as_str()) {
            after_wrapper = true;
            continue;
        }
        return Some(base);
    }
    None
}

/// What a typed command asks of the Host besides its status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Offer {
    /// A built-in Agent that is not Watched: offer to Watch it.
    Watch(String),
    /// A Watched built-in, hooks on: make sure its hooks are written (a
    /// mid-session install), and offer a restart if they were not.
    Provision(String),
}

impl Default for AgentCommands {
    fn default() -> Self {
        Self {
            list: RwLock::new(builtin_agents()),
            offers: RwLock::new(OfferState { hooks_enabled: true, ..OfferState::default() }),
        }
    }
}

fn is_builtin(id: &str) -> bool {
    crate::host_settings::BUILTIN_AGENT_IDS.contains(&id)
}

impl AgentCommands {
    pub fn set(&self, agents: Vec<AgentCommand>) {
        if let Ok(mut a) = self.list.write() {
            *a = agents;
        }
        // A switch may have moved, and hooks with it: look again.
        if let Ok(mut o) = self.offers.write() {
            o.provisioned.clear();
        }
    }

    /// The Host settings the Watch offer reads: the Status Hooks setting and
    /// the declined Agents.
    pub fn set_offer_settings(&self, hooks_enabled: bool, declined: &[String]) {
        if let Ok(mut o) = self.offers.write() {
            o.hooks_enabled = hooks_enabled;
            o.declined = declined.iter().cloned().collect();
            o.provisioned.clear();
        }
    }

    /// *Not now*: no Watch offer for `agent_id` until this Host starts again.
    pub fn snooze(&self, agent_id: &str) {
        if let Ok(mut o) = self.offers.write() {
            o.snoozed.insert(agent_id.to_string());
        }
    }

    /// `agent_id`'s hooks are known to be written: its next typed start
    /// needs no check.
    pub fn mark_provisioned(&self, agent_id: &str) {
        if let Ok(mut o) = self.offers.write() {
            o.provisioned.insert(agent_id.to_string());
        }
    }

    /// The Agent `text` starts, if any.
    pub fn matching(&self, text: &str) -> Option<String> {
        let a = self.list.read().ok()?;
        match_agent(text, &a).map(|a| a.id.clone())
    }

    /// What typing `text` asks of the Host, if anything: a Watched built-in
    /// to provision (unless already known provisioned), or an un-Watched one
    /// to offer (not declined, not snoozed). Only when the line's command is
    /// the Agent ([`command_word`]), since a banner the user sees, and a
    /// restart that kills what the line runs, must not follow a mere
    /// mention. Custom Agents never: the user added them on purpose.
    pub fn offer_for(&self, text: &str) -> Option<Offer> {
        let word = command_word(text)?;
        let list = self.list.read().ok()?;
        let o = self.offers.read().ok()?;
        let a = list
            .iter()
            .filter(|a| is_builtin(&a.id))
            .find(|a| a.command.to_lowercase() == word)?;
        if a.enabled {
            return (o.hooks_enabled && !o.provisioned.contains(&a.id)).then(|| Offer::Provision(a.id.clone()));
        }
        (!o.declined.contains(&a.id) && !o.snoozed.contains(&a.id)).then(|| Offer::Watch(a.id.clone()))
    }
}

/// Told to a PTY's Windows: offer to Watch its Agent, or to restart it.
pub const WATCH_OFFER_EVENT: &str = "watch-offer";
/// Told to every Client: the offer for this Agent is answered.
pub const WATCH_OFFER_CLOSED_EVENT: &str = "watch-offer-closed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchOffer {
    pub pty_id: String,
    pub agent_id: String,
    /// `"watch"`: the Agent is not Watched. `"restart"`: its hooks were just
    /// written and the running Agent has not read them.
    pub kind: &'static str,
}

/// Raise the Watch offers `commands` call for, and write the hooks of a
/// Watched built-in typed at the prompt (on a thread of its own: it is disk
/// work, and the shell's reports must not wait for it).
fn handle_offers(
    pty: &str,
    commands: &[ShellCommand],
    agents: &std::sync::Arc<AgentCommands>,
    status: &crate::status_store::StatusStore,
    events: &crate::event_sink::Events,
) {
    use crate::event_sink::EventsExt;
    for c in commands {
        let ShellCommand::CommandStart { command_text: Some(text) } = c else { continue };
        match agents.offer_for(text) {
            Some(Offer::Watch(agent_id)) => {
                let offer = WatchOffer { pty_id: pty.to_string(), agent_id, kind: "watch" };
                for watcher in status.watchers(pty) {
                    events.to_client(&watcher, WATCH_OFFER_EVENT, &offer);
                }
            }
            Some(Offer::Provision(agent_id)) => {
                let watchers = status.watchers(pty);
                let (pty, events, agents) = (pty.to_string(), events.clone(), agents.clone());
                std::thread::spawn(move || match crate::agent_hooks::ensure_agent_hooks(&agent_id, true) {
                    Ok(true) => {
                        agents.mark_provisioned(&agent_id);
                        log::info!("[watch offer] wrote {agent_id}'s hooks on a typed start");
                        let offer = WatchOffer { pty_id: pty, agent_id, kind: "restart" };
                        for watcher in watchers {
                            events.to_client(&watcher, WATCH_OFFER_EVENT, &offer);
                        }
                    }
                    Ok(false) => agents.mark_provisioned(&agent_id),
                    // No restart offer: with no curl the hooks never fire, and
                    // a broken config is still broken. The next start tries
                    // again.
                    Err(e) => log::warn!("[watch offer] cannot write {agent_id}'s hooks: {e}"),
                });
            }
            None => {}
        }
    }
}

/// Apply every PTY's shell reports to `status`, telling each PTY's owning
/// Window (if any) what changed.
pub fn listen(
    ptys: &crate::pty_manager::PtyManager,
    status: std::sync::Arc<crate::status_store::StatusStore>,
    agents: std::sync::Arc<AgentCommands>,
    events: crate::event_sink::Events,
) {
    use crate::event_sink::EventsExt;
    ptys.on_shell(std::sync::Arc::new(move |pty: &str, commands: Vec<ShellCommand>| {
        let config = crate::status_machine::StatusConfig::default();
        handle_offers(pty, &commands, &agents, &status, &events);
        let updates = status.shell_commands(pty, &commands, &agents, crate::hook_apply::now_ms(), &config);
        if !updates.is_empty() {
            for watcher in status.watchers(pty) {
                events.to_client(&watcher, "status-updates", updates.clone());
            }
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParseCase {
        chunks: Vec<String>,
        expected: Vec<Vec<ShellCommand>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MatchCase {
        text: String,
        agents: Vec<AgentCommand>,
        expected: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        builtins: Vec<AgentCommand>,
        parse: Vec<ParseCase>,
        matches: Vec<MatchCase>,
    }

    fn fixture() -> Fixture {
        let raw = include_str!("../../../../src/lib/__tests__/fixtures/shellIntegration.json");
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn finds_the_commands_the_window_finds_however_the_output_is_cut() {
        let f = fixture();
        assert!(f.parse.len() > 100);
        for (n, case) in f.parse.iter().enumerate() {
            let mut p = Parser::default();
            for (i, chunk) in case.chunks.iter().enumerate() {
                assert_eq!(p.parse(chunk.as_bytes()), case.expected[i], "case {n} chunk {i}: {chunk:?}");
            }
        }
    }

    #[test]
    fn matches_agents_as_the_window_does() {
        let f = fixture();
        assert!(f.matches.len() >= 100);
        for case in &f.matches {
            let got = match_agent(&case.text, &case.agents).map(|a| a.id.clone());
            assert_eq!(got, case.expected, "{:?}", case.text);
        }
    }

    #[test]
    fn knows_the_windows_built_in_agents() {
        assert_eq!(builtin_agents(), fixture().builtins);
    }

    fn commands(watched: &[&str]) -> AgentCommands {
        let a = AgentCommands::default();
        let mut list: Vec<AgentCommand> = builtin_agents()
            .into_iter()
            .map(|mut b| {
                b.enabled = watched.contains(&b.id.as_str());
                b
            })
            .collect();
        list.push(AgentCommand { id: "custom-1".into(), command: "mycli".into(), enabled: false });
        a.set(list);
        a
    }

    #[test]
    fn offers_to_watch_an_unwatched_built_in_typed_at_the_prompt() {
        let a = commands(&["claude"]);
        assert_eq!(a.offer_for("codex --full-auto"), Some(Offer::Watch("codex".into())));
        assert_eq!(a.offer_for("/opt/bin/gemini"), Some(Offer::Watch("gemini".into())));
        assert_eq!(a.offer_for("ls -la"), None);
        assert_eq!(a.offer_for("codexify"), None);
        assert_eq!(a.offer_for("FOO=1 env -i BAR=2 codex"), Some(Offer::Watch("codex".into())));
        assert_eq!(a.offer_for("npx -y @openai/codex"), Some(Offer::Watch("codex".into())));
        assert_eq!(a.offer_for(""), None);
    }

    #[test]
    fn a_line_that_only_names_the_agent_is_not_an_offer() {
        let a = commands(&["claude"]);
        for line in [
            "brew install codex",
            "npm i -g @openai/codex",
            "which gemini",
            "man qwen",
            "git commit -m \"fix codex bug\"",
            "brew upgrade claude",
        ] {
            assert_eq!(a.offer_for(line), None, "{line}");
        }
    }

    #[test]
    fn a_provisioned_agent_is_checked_once_until_something_changes() {
        let a = commands(&["claude"]);
        a.mark_provisioned("claude");
        assert_eq!(a.offer_for("claude"), None);
        a.set_offer_settings(true, &[]);
        assert_eq!(a.offer_for("claude"), Some(Offer::Provision("claude".into())));
        a.mark_provisioned("claude");
        a.set(builtin_agents());
        assert_eq!(a.offer_for("claude"), Some(Offer::Provision("claude".into())));
    }

    #[test]
    fn finds_the_command_word() {
        assert_eq!(command_word("  /opt/bin/Codex --x"), Some("codex".into()));
        assert_eq!(command_word("A=1 B=2"), None);
        assert_eq!(command_word("sudo -E time qwen"), Some("qwen".into()));
        assert_eq!(command_word(""), None);
    }

    #[test]
    fn never_offers_a_custom_agent() {
        assert_eq!(commands(&[]).offer_for("mycli run"), None);
    }

    #[test]
    fn a_declined_or_snoozed_agent_is_not_offered() {
        let a = commands(&[]);
        a.set_offer_settings(true, &["codex".to_string()]);
        assert_eq!(a.offer_for("codex"), None);
        a.snooze("gemini");
        assert_eq!(a.offer_for("gemini"), None);
        assert_eq!(a.offer_for("qwen"), Some(Offer::Watch("qwen".into())));
        // A new Host settings write keeps the snooze: it lasts until the next start.
        a.set_offer_settings(true, &[]);
        assert_eq!(a.offer_for("gemini"), None);
        assert_eq!(a.offer_for("codex"), Some(Offer::Watch("codex".into())));
    }

    #[test]
    fn the_offer_still_shows_with_hooks_off() {
        let a = commands(&[]);
        a.set_offer_settings(false, &[]);
        assert_eq!(a.offer_for("codex"), Some(Offer::Watch("codex".into())));
    }

    #[test]
    fn a_watched_built_in_is_provisioned_only_with_hooks_on() {
        let a = commands(&["claude"]);
        assert_eq!(a.offer_for("claude"), Some(Offer::Provision("claude".into())));
        a.set_offer_settings(false, &[]);
        assert_eq!(a.offer_for("claude"), None);
    }

    #[test]
    fn a_watched_custom_agent_is_not_provisioned() {
        let a = commands(&[]);
        a.set(vec![AgentCommand { id: "custom-1".into(), command: "mycli".into(), enabled: true }]);
        assert_eq!(a.offer_for("mycli"), None);
    }

    #[test]
    fn reads_the_payloads() {
        let mut p = Parser::default();
        assert_eq!(
            p.parse(b"\x1b]7770;command_start;vibe\x07out\x1b]7770;command_end;130\x07\x1b]7770;cwd;/x\x07"),
            vec![
                ShellCommand::CommandStart { command_text: Some("vibe".into()) },
                ShellCommand::CommandEnd { exit_code: Some(130) },
                ShellCommand::Cwd { path: "/x".into() },
            ]
        );
        assert_eq!(parse_int(" -2x"), Some(-2));
        assert_eq!(parse_int("x"), None);
    }
}
