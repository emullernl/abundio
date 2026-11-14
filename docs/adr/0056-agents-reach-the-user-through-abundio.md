---
status: accepted
---

# Agents reach the user through Abundio

With **Agent control** (ADR-0054, ADR-0055) Agents can drive each other, but they have no way to reach the user except through their own terminal. An Agent that needs the user to look has to wait until it ends its turn. And while it works, the only sign of what it is doing is its status icon.

An Agent that needs an answer already has a way to ask: every coding Agent has its own question tool, and a question asked with it shows the Pane as **Waiting**, which counts in the **Attention count** and sends a notification when the user is elsewhere. The one gap is a helper: when an Agent works for another Agent, its caller sees the question before the user does.

We decided to give Agents two commands that speak to the user, each acting only on the calling Agent's own Pane, and to leave questions to the Agents' own tools:

- **`notify` sets an Attention flag, separate from the Pane's status.** The Pane may still be Working, so `notify` must not fake a status: a fake Waiting would be wiped by the Agent's next real status change. The flag counts in the **Attention count** and clears when the user focuses the Pane or a new prompt reaches it. A desktop notification comes with it under the same rule as Ready and Waiting (the Window is in the background or the Pane is not visible), and at most once a minute per Pane. Calls inside that minute only update the flag's message.
- **`progress` sets a Progress line**, a short text shown wherever the Pane is named. It is kept only in memory and lasts until the Agent replaces or clears it, or leaves the Pane.
- **These two, and `worktree new`, are refused unless the calling Pane is in agent mode.** They speak or act in an Agent's name, and a plain shell has none. This is the per-command limit chosen instead of turning Agent control off by default (see the token risk in ADR-0054). It does not stop a script run *by* an Agent, which shares its Pane. The rate limit on desktop notifications is there for that case, and for Agents caught in a loop.

## Considered Options

- **An `ask` command** that shows a card with the question on the asking Pane and waits for the answer. Built, then dropped: each coding Agent already has its own question tool, which shows Waiting and notifies the user without new UI. Instead the skill tells a calling Agent that finds its helper Waiting to answer only what it can settle from its own task, and to ask the user in its own conversation for the rest. A modal dialog or a sidebar inbox of questions were rejected before that, for interrupting the user and for being easy to overlook.
- **`notify` as Waiting.** Rejected: see above.
- **`status` as the command's name.** Rejected: "status" already means Working, Ready, Waiting and so on, in the app and in the skill.
- **Turn Agent control off by default**, or allow it only in agent-mode Panes. Rejected by the user in favour of limits on each command. Read-only commands and the notes commands stay open to shells, so scripts can use them.

## Consequences

- The **Attention count** gains a second source besides PTY status. A Pane counts once, whether it has an open status, a flag, or both.
- **Agents have full control of the Workspace's notes**: `notes append` adds signed text; `notes edit` replaces the one place a quoted text appears, and `notes write` replaces the whole note, both unsigned. They read and write the same Markdown-like text `notes read` prints, and `notes edit` rebuilds only the paragraphs and list items it touches, so the rest keeps what text cannot express. Considered: append only (the first version), which left Agents unable to tick an item or fix a stale line; and real Markdown, which the editor's few formats do not need. The skill tells Agents to change only their own lines unless the user asks.
- A helper's question reaches the user through its caller, so the caller may answer a question it should have passed on. The skill draws the line: permission prompts and questions settled by the caller's task, yes; anything that needs the user's judgment, no.
