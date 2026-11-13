---
status: accepted
---

# Agents reach the user through Abundio

With **Agent control** (ADR-0054, ADR-0055) Agents can drive each other, but they have no way to reach the user except through their own terminal. An Agent working for another Agent asks its questions in a Pane nobody is watching, and its caller, not the user, sees them. An Agent that needs the user to look has to wait until it ends its turn. And while it works, the only sign of what it is doing is its status icon.

We decided to give Agents three commands that speak to the user, each acting only on the calling Agent's own Pane:

- **`ask` shows a Question card on the asking Pane, never a modal.** The card does not take keyboard focus, so the user can keep typing elsewhere. Several Panes can have one open at once (one per Pane). The Pane shows as **Waiting** while it is open, so the existing status icon, Attention count and notification rules apply without new ones. The call is a wait like `agent wait`: it ends when the user answers or dismisses the card (the Agent learns it was declined), when the call times out or is cancelled, or when the Pane closes. An answer that arrives after that is not kept.
- **`notify` sets an Attention flag, separate from the Pane's status.** The Pane may still be Working, so `notify` must not fake a status: a fake Waiting would be wiped by the Agent's next real status change. The flag counts in the **Attention count** and clears when the user focuses the Pane or a new prompt reaches it. A desktop notification comes with it under the same rule as Ready and Waiting (the Window is in the background or the Pane is not visible), and at most once a minute per Pane. Calls inside that minute only update the flag's message.
- **`progress` sets a Progress line**, a short text shown wherever the Pane is named. It is kept only in memory and lasts until the Agent replaces or clears it, or leaves the Pane.
- **These three, and `worktree new`, are refused unless the calling Pane is in agent mode.** They speak or act in an Agent's name, and a plain shell has none. This is the per-command limit chosen instead of turning Agent control off by default (see the token risk in ADR-0054). It does not stop a script run *by* an Agent, which shares its Pane. The rate limit on desktop notifications is there for that case, and for Agents caught in a loop.

## Considered Options

- **A modal dialog for `ask`**, like the Prompt action dialog. Rejected: it interrupts whatever the user is typing, only one can show at a time, and an unattended Agent could pop one at any moment.
- **A sidebar inbox of questions.** Rejected: easy to overlook, and the question is far from the Pane it is about.
- **Keep the answer after the call ends**, and collect it with a second command. Rejected for now: it needs storage and a second command, and a wait with `--timeout 0` already covers long answers.
- **`notify` as Waiting.** Rejected: see above.
- **`status` as the command's name.** Rejected: "status" already means Working, Ready, Waiting and so on, in the app and in the skill.
- **Turn Agent control off by default**, or allow it only in agent-mode Panes. Rejected by the user in favour of limits on each command. Read-only commands and `notes append` stay open to shells, so scripts can use them.

## Consequences

- The **Attention count** gains a second source besides PTY status. A Pane counts once, whether it has an open status, a flag, or both.
- A Pane's displayed Waiting can now come from an open Question card as well as from the Agent. It is derived when shown, never written into the status machine, so the Agent's own status changes cannot clear it.
- The skill tells Agents to use `ask` only when working for another Agent, or when they need a choice partway through a task. Otherwise they ask in their own conversation, which the user already sees.
