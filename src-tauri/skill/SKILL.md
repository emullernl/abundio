---
name: abundio
description: Work with the other agents and terminal panes in Abundio — in your own Workspace, and in the other Workspaces of your Profile when the user asks — list them, read their output, prompt another agent and wait for its answer, start a helper agent in a new pane or a new git worktree, run a command in an idle shell and wait for its output, share the Workspace's notes, and reach the user (call them over, show your progress). Use when the user asks you to delegate to, coordinate with, check on or review the work of another agent, or to use another pane. Only works inside an Abundio pane.
---

# Abundio: other agents and panes

Abundio is the terminal app you may be running in. Its `abundio` command lets
you see and drive the other panes of your Workspace, and of the other
Workspaces of your Profile.

## First, check you are inside Abundio

Run `printenv ABUNDIO_AGENT_TOKEN`. If it prints nothing, you are **not** in
an Abundio pane: stop here and do not use this skill or the `abundio` command.

## Learn the commands

`abundio help` prints every command. Each one prints one JSON object on
stdout and exits 0. Errors print `{"error":{"code","message"}}` on stderr and
exit 1; a usage error exits 2. Read the message: it says what to do next.

## Look before you act

Start with `abundio agent list` (or `abundio pane list` for shells too). Each
pane has a **Pane number** (`p1`, `p2`, …), and every agent has a name, its
**Agent handle** ("Agent One" by default, or one the user chose, like
"Reviewer"). Address a pane by either; a name is matched ignoring case, so
`reviewer` finds "Reviewer". Quote a name with spaces: `"Agent Two"`.
`"self": true` is you. `abundio agent rename "<name>"` names you, if the user
asks.

## Talk to another agent

- `abundio agent prompt <agent> "<text>" --wait` sends a prompt and returns
  when that agent has finished its turn (`status`: `ready`, `waiting` or
  `error`). Prefer this to sending and polling.
- `status: "waiting"` means it is asking a question or wants permission:
  `abundio pane read <agent> --lines 40` to see it. Answer it yourself only
  when your own task settles it (a permission prompt for work you asked for,
  a detail you already know), with `abundio agent send-keys <agent> …`
  (`enter`, `esc`, `up`, `down`, `tab`, `ctrl+c`, …) or with another prompt.
  If it needs the user's judgment, ask the user in your own conversation,
  then pass their answer on the same way.
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

To give the agent its own command-line arguments, add one `--agent-arg` per
argument: `--agent-arg --model --agent-arg o3`. This works in every shell,
PowerShell too (which would drop a bare `--`).

The new pane does not take the user's keyboard focus, so they can keep
typing to you. Add `--focus` (to `agent start`, `pane split` or `tab new`)
only when the user asks to be taken to the new pane.

### In a Tab of its own

Add `--tab` to `agent start` to open the helper in a new Tab instead of
splitting yours. Prefer it when:

- a reply came back with a `"hint"` (your Tab is getting crowded), or
- your Tab already has several panes, or the helper's work is long and
  separate from yours.

The Tab is named after the task; `--tab-name "<name>"` sets a better one.
`abundio tab rename "<name>"` names your own Tab, for example after the
task you are on. You can rename only your own Tab and Tabs you opened, and
never one the user has named: leave those as they are.

`abundio pane split` opens a plain shell beside you, `abundio tab new` one in
a new Tab; `abundio pane run <pane> "<command>"` runs one line in a shell
that is at its prompt.

### Waiting for output

`abundio pane watch <pane> --match "<regex>"` waits for a line of output,
printed after you call it, that matches (a JavaScript regex; `-i` ignores
case), and prints it. Use it after `pane run` to wait for a dev server
("ready in", "listening on") or a build to finish, instead of polling.

### In a worktree of its own

`abundio worktree new <branch> --agent <kind> --prompt "<task>"` makes a git
worktree of your repository (a branch in its own folder), opens it as a new
Workspace in the background, and starts the helper there. Use it when the
helper's work should happen on a separate branch. The helper is yours, as
with `agent start`; address it with `--workspace` (the reply names the
Workspace). Without `--agent` it only makes the worktree.

## The Workspace's notes

`abundio notes read` prints the Workspace's notes (the Notes panel), which the
user and other agents share. `abundio notes append "<text>"` adds to the end,
signed with your name: paragraphs, `- ` bullets and `- [ ] ` checklist items.
Use it to leave a short handoff or decision others will need. You cannot
change what is already there.

## Reaching the user

These act on your own pane only.

- `abundio progress "<what you are doing>"` shows a short line (up to 80
  characters) beside your name; update it at each stage of a long task, and
  `abundio progress --clear` when done.
- `abundio notify "<message>"` marks your pane so the user comes and looks,
  and may show a desktop notification. Use it when you have finished
  something they are waiting for, not for every step.
- To ask the user something, use your own way of asking questions. Your
  pane then shows as waiting and the user is notified; if another agent
  started you, it will pass the question on.

## Other Workspaces

Your Profile may have other Workspaces (other repositories, or other worktrees
of yours). `abundio workspace list` shows them, with their agents and whether
each is open. Add `--workspace <name>` to any command to act there, e.g.
`abundio agent prompt "Reviewer" "<text>" --wait --workspace api`.

- Stay in your own Workspace unless the user names another one or asks you
  to work across them.
- A Workspace that is not open is opened for your call, which starts all its
  agents. Never do that uninvited.
- A new pane in another Workspace always gets a Tab of its own there.

## Be a good neighbour

- Only close panes you created: `abundio pane close <pane>`. Closing others
  is refused.
- Do not prompt an agent the user is working with unless the user asked you
  to.
- Keep prompts self-contained: the other agent cannot see your conversation.
