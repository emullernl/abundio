---
status: accepted
---

# The Orchestrator is a hidden, app-managed Workspace per Profile

Users want one Agent they can simply ask "what is everyone doing, and who needs me?", including users with no coding or Agent experience. **Agent control** (ADR-0054, ADR-0055) already lets any Agent see and drive every Agent in its **Profile**, so the **Orchestrator** needs no new powers: it needs a home and a view.

We decided that each Profile has exactly one **Orchestrator workspace**: an ordinary Workspace row in the database, so panes, Tabs, PTYs, **Session resume**, **Prompt actions** and Agent control all work unchanged, but bound to a folder Abundio creates and owns inside the app data folder (`<data>/abundio/orchestrator/<profile>/Orchestrator/`, the shared root, not the epoch root), and shown **only** in the new **Orchestrator view**. It is left out of the Left sidebar's Workspace list, the **Agents list**, the **Fleet Console** and the **Workspace cycle**, but still counts in the **Overview bar** and the **Attention count**. Its Agent has the reserved, non-renamable handle `Orchestrator`.

Abundio rewrites the Orchestrator's own instructions file on every start (its role, plain-language answers, and *ask the user before prompting, sending keys to, starting or closing another Agent*) and includes a second file the user may edit, which Abundio never touches. The ask-first rule lives in those instructions, not in Agent control: Agent control still never asks (ADR-0054); the **Control badge** and the graph's animated edges show what happens.

With this, every view of a Window — **Workspace view**, Fleet Console, Orchestrator view — is restored on launch. This reverses the Fleet Console's "never restored" rule (its glossary entry; ADR-0040 is silent on it): a user who lives in the Orchestrator view should not land somewhere else on every start, and one rule for all views is easier than two.

## Considered Options

- **One Orchestrator for the whole app.** Rejected: Agent control never crosses Profiles (ADR-0055), so it could not see the other Profiles anyway.
- **A user-chosen or visible folder** (`~/Abundio/Orchestrator`, a dotfolder). Rejected: visible folders get moved or deleted (a **Missing folder** starts nothing, ADR-0053), and dotfolders are not hidden on Windows. App-managed state belongs in the app data folder.
- **A new non-Workspace concept** for the Orchestrator. Rejected: it would have to re-implement panes, Tabs, PTY lifetime and Agent control routing, all of which are Workspace-shaped.
- **Listing it as a pinned Workspace** in the sidebar and the Console. Rejected: it then looks like any Workspace and can be closed or deleted by accident.
- **A custom chat UI** driving the Agent headless. Rejected for now: a large new subsystem with per-Agent support, and it loses the Agent's own approval prompts. Friendliness comes instead from seeded Prompt actions, a welcome card and the graph.

## Consequences

- Every code path that lists a Profile's Workspaces must decide whether it includes the Orchestrator workspace. Most must not. The Orchestrator's own `abundio workspace list` must not list itself as a work Workspace.
- Agent handles are unique per Profile (ADR-0055), so `Orchestrator` is refused for every other Agent.
- Restoring the Orchestrator view starts the Orchestrator's Agent at launch.
- Restoring the Fleet Console at launch shows the tiles of the restored Workspaces as Workspace restore (ADR-0052) opens them.
- **The Orchestrator's Agent is started through the PTY spawn**, as a **New task** is (ADR-0042), never by a typed line (zsh and bash; other shells get the typed line). The spawn script sees the Agent's own exit code, so the Orchestrator is the one exception to ADR-0050's "no fallback": a resume (`claude --continue`) that exits non-zero within 20 seconds found nothing to resume, and the plain command runs instead, inside the same agent-mode command, so the pane keeps its Agent and handle. A newly picked Agent never resumes. Found when a first Orchestrator typed `claude --continue`, which took about 8 seconds to fail with "No conversation found to continue". Kept to the Orchestrator on purpose: everywhere else a non-zero exit may be the user quitting.

