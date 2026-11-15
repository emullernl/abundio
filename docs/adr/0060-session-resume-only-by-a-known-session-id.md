---
status: accepted
---

# Session resume only by a known session id

Supersedes rule 2 of ADR-0050 and the `--continue` resume in ADR-0057.

A relaunched Agent now resumes only when its pane knows the Agent's own **Agent session id**. With no id, it starts fresh. The "most recent session in this folder" form (`--continue`, Gemini `--resume latest`, `codex resume --last`) is gone. Before, a pane used it when it was the only pane running that Agent in its folder.

The reason is predictability. Under the old rule, whether a pane resumed depended on how many other panes ran the same Agent in the same folder, and that number changes as panes open and close. The user could not tell in advance what a relaunch would do. "Most recent session in this folder" could also be a session the pane never had: one started in a terminal outside Abundio, or in a pane since closed. Now one rule covers every pane: an id resumes that session, no id starts fresh.

- **Built-in Agents** report their session id through their hooks early in a session, so they keep resuming as before. The exception is OpenCode 1.x, whose payloads cannot be told apart from child sessions (ADR-0050), so it now always starts fresh.
- **Custom Agents** have no hooks and never get an id, so they always start fresh. Settings no longer offers a "Continue arguments" field. A saved `continueArgs` is stripped when settings load.
- **The Orchestrator** follows the same rule. It keeps its 20-second plain-start fallback for a resume by id that fails, for example on a deleted session. Its Agent's exit clears the id from the pane, as with any pane. So the Window remembers, in memory, the last id the Orchestrator's Agent reported. Picking the same Agent again after it exits resumes by that id. Across an app restart the pane itself still holds the id.
- A pane whose Agent never reported an id starts fresh with no notice. This happens when hooks are off or broken, or when the app quits before the first hook fires.

## Considered Options

- **Keep `--continue` for the Orchestrator only**, since it is always alone in its folder. Rejected: it keeps an exception to the rule, and it could still pick up a session started outside Abundio in that folder.
- **Keep the form for custom Agents only.** Rejected for the same unpredictability. A resume-by-id field would never fire, because custom Agents report no id.
- **Print a note in the pane when a resume is not possible.** Rejected as noise: it should be rare for built-ins.
