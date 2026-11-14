---
status: accepted
---

# Agent control reaches the whole Profile, and every Agent has a name

ADR-0054 limited **Agent control** to the caller's own **Workspace**: an Agent could see and drive only the Panes beside it. That ruled out work people want to hand between Workspaces, such as an Agent on one **Linked worktree** asking another to review its branch, or one repository's Agent checking how a sibling repository's Agent is doing. It also kept **Agent handles** optional and unique only within a Workspace, so most Agents were known only by a **Pane number**, which means nothing outside its Workspace.

We decided:

- **An Agent reaches every Workspace of its own Profile, never another Profile.** Its own Workspace stays the default; `--workspace <name>` names another (matched ignoring case, refused if two Workspaces share the name). The Profile is the boundary because it is already the one the user draws between contexts, such as work and personal. The per-pane token of ADR-0054 is unchanged: it still says who is calling, and Rust now checks the target Workspace's Profile against the caller's instead of comparing Workspaces.
- **Every command works in another Workspace, but never reshapes its layout.** A new Pane there always gets a Tab of its own, its Pane owned by the caller, instead of splitting a Pane the user may be looking at in that Workspace.
- **A Workspace that is not Opened is opened for the call,** in the background, exactly as the user would open it: its Panes spawn, its Agents relaunch with **Session resume**, it joins the Profile's restore list, and the user's view does not move. A Workspace whose folder is missing is still refused (ADR-0053). The skill tells Agents to cross Workspaces only when the user asks, because opening one can start several Agents.
- **Rust routes each call to the Window that holds the target Workspace**, or to the caller's Window when it has to be opened there. The Window still carries the call out (ADR-0054).
- **Every Agent has a name.** An Agent handle becomes a readable name ("Agent Two", "Reviewer"): letters, digits, spaces, `-` and `_`, up to 32 characters, matched ignoring case and treating a space and a dash alike. A Pane entering agent mode without one gets a **Default handle**, "Agent" and the lowest number in words not in use in the Profile. Handles are unique in the Profile, so an Agent can be addressed by name from any Workspace. Every name, chosen or default, goes with its Agent when it leaves the Pane, as before.
- **Rust checks handle uniqueness,** across all the Profile's layouts in the database. Each Window holds only a copy of other Windows' layouts, which can be stale.

## Considered Options

- **Keep the Workspace boundary.** Rejected: it blocks the cross-worktree and cross-repository work that prompted this, and the user can already see every Workspace of the Profile, so the Agent seeing them hides nothing from the user.
- **Reach every Profile.** Rejected: Profiles exist to keep contexts apart, and Agent control should not be the way around that.
- **Only the caller's worktree set**, or **only its Window.** Rejected: the first leaves out unrelated repositories the user works on together; the second splits one Profile in two when it has two Windows, an accident of window layout.
- **Only Opened Workspaces; refuse the rest.** Rejected by the user in favour of opening on demand: an Agent asked to check on another Workspace should not need the user to open it first.
- **Open without relaunching Agents.** Rejected: every other way of opening a Workspace relaunches them, and a second kind of "opened" would be one more state to explain.
- **Split a Pane in the other Workspace**, beside its Focused pane or a named one. Rejected: it rearranges a layout the user may be in the middle of using.
- **Keep handles lowercase words, and show `agent-one` as "Agent One".** Rejected: two spellings of one thing. One readable name, matched loosely, is what people both see and type.
- **Default handles that are never reused**, like Pane numbers. Rejected: names would climb ("Agent Thirty-Seven"). Reusing the lowest free number keeps them short; the cost is that an old reference to "Agent Two" can reach a newer Agent.
- **Unique handles per Workspace only.** Rejected: with reach across the Profile, "Agent One" would mean different Agents in different Workspaces.

## Consequences

- A caller and its **Spawned panes** can sit in different Workspaces and different Windows. Releasing them when the owner closes can no longer be done by one Window's store alone; the other Windows of the Profile are told.
- The **Control badge** names the caller's Workspace when the caller is in another one.
- The wait graph needs no change: Pane ids are unique app-wide, so a loop across Workspaces is still caught.
- Handles set before this change (`reviewer`) are still valid. Agents running without one get a Default handle when this ships.
- The grammar change means a handle may contain spaces, so every CLI command that takes a handle must accept a quoted one.
