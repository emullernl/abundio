---
name: abundio
description: Work with the other agents and terminal panes in your Abundio Workspace — list them, read their output, prompt another agent and wait for its answer, start a helper agent in a new pane, or run a command in an idle shell. Use when the user asks you to delegate to, coordinate with, check on or review the work of another agent, or to use another pane. Only works inside an Abundio pane.
---

# Abundio: other agents and panes

Abundio is the terminal app you may be running in. Its `abundio` command lets
you see and drive the other panes of your Workspace.

## First, check you are inside Abundio

Run `printenv ABUNDIO_AGENT_TOKEN`. If it prints nothing, you are **not** in
an Abundio pane: stop here and do not use this skill or the `abundio` command.

## Learn the commands

`abundio help` prints every command. Each one prints one JSON object on
stdout and exits 0. Errors print `{"error":{"code","message"}}` on stderr and
exit 1; a usage error exits 2. Read the message: it says what to do next.

## Look before you act

Start with `abundio agent list` (or `abundio pane list` for shells too). Each
pane has a **Pane number** (`p1`, `p2`, …) and may have an **Agent handle**
(`reviewer`). Address a pane by either. `"self": true` is you.

## Talk to another agent

- `abundio agent prompt <agent> "<text>" --wait` sends a prompt and returns
  when that agent has finished its turn (`status`: `ready`, `waiting` or
  `error`). Prefer this to sending and polling.
- `status: "waiting"` means it is asking a question or wants permission:
  `abundio pane read <agent> --lines 40` to see it, then answer with
  `abundio agent send-keys <agent> …` (`enter`, `esc`, `up`, `down`, `tab`,
  `ctrl+c`, …) or with another prompt.
- After a prompt, `abundio pane read <agent> --lines 80` shows its answer.
- `stalled` means it never started working; read the pane before sending
  again. After a `timeout` or `connection_lost`, the prompt may have arrived:
  read the pane before you re-send anything.
- `busy` means it is waiting on its user; do not push past that.

## Start a helper

`abundio agent start --kind <agent-id> --handle <name> --prompt "<task>"`
opens a new pane beside yours and starts that agent with the task. The kinds
are the agents switched on in Abundio (`agent list` shows the ones running;
an unknown kind's error lists the valid ones). Then
`abundio agent wait <name>` until it is done, and read its pane.

`abundio pane split` opens a plain shell beside you;
`abundio pane run <pane> "<command>"` runs one line in a shell that is at its
prompt.

## Be a good neighbour

- Only close panes you created: `abundio pane close <pane>`. Closing others
  is refused.
- Do not prompt an agent the user is working with unless the user asked you
  to.
- Keep prompts self-contained: the other agent cannot see your conversation.
