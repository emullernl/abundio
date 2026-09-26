# Plan: New task

## Context

The user wants to start an Agent *on something*: type a problem or feature description, or pick a GitHub issue, and have a **Task-capable** Agent start with that as its first prompt. It should run in the current Workspace (restarting an agent Pane or adding a Tab) or in a fresh worktree. Terms are defined in `CONTEXT.md` (**New task**, **Task**, **Issue task**, **Task template** / **Issue template**, **Task destination**, **Task-capable**). The launch mechanism is ADR-0042.

## Decisions (resolved with the user)

- **Delivery:** a launch flag on the Agent's command line. Only **Task-capable** Agents are offered. Kimi Code and Aider are excluded.
- **Launch:** the PTY is spawned as `shell -l -i -c '<task script>' abundio-task <agent argv…> <prompt>` (ADR-0042). The prompt is passed as a separate argument, so nothing needs quoting and nothing reaches history or the environment. Supported shells: zsh and bash. Any other shell (fish, PowerShell, cmd.exe) gets a clear "not supported yet" message.
- **Task-capable forms (built-in, fixed):** `claude {prompt}`, `copilot -i {prompt}`, `gemini -i {prompt}`, `codex {prompt}`, `opencode --prompt {prompt}`, `qwen -i {prompt}`, `grok {prompt}`. Custom Agents get an optional *task argument form* field. Filled in means Task-capable.
- **Badge:** a *Task-capable* badge in Settings ▸ Agents, next to *Detected*.
- **Destinations:** Restart agent · New tab · New worktree (git Workspaces only). No plain terminal.
  - Restart targets the Focused pane (or Focused tile) if it runs an Agent, else the only agent Pane, else a picker. It respawns the PTY and asks first when the Agent is Working or Waiting.
  - The Restart/New tab choice is a global setting. It changes only on an explicit pick.
  - The Agent defaults to the target Pane's or Workspace's Agent and can be changed. For New worktree it defaults to the Workspace's Agent.
  - New worktree has branch and folder fields inline in the same dialog, prefilled from an issue (`issue-123-fix-login`). It uses the existing create path (from the Primary, then setup commands, then the Agent).
- **Issues:** open issues of the Workspace's GitHub repo, newest first, assigned-to-me pinned, with a search box. Plus an optional note that is *appended* after the resolved template (there is no `{{note}}` slot). Only number, title and URL are templated.
- **Templates:** two global templates in Settings. The Task template takes `{{input}}`, the Issue template takes `{{number}}`, `{{title}}` and `{{url}}`. Each has a Reset to default. Collapsed read-only preview in the dialog.
- **Tab name:** from the Task (`#123 Fix login redirect`, or the first ~30 characters). A restarted Pane keeps its name.
- **Entry points:** `Cmd+Shift+T` / `Ctrl+Shift+T`, Command palette, a button beside the Tab bar's `+`, the sidebar row menu, and the Fleet Console's Add agent choice and toolbar. In the Console the target defaults to the Focused tile's Workspace, via the same grouped Workspace picker as New agent.
- **Never re-sent:** the Pane remembers only its Agent id. Auto-relaunch and Relaunch run the plain command.
- **One branch, ordered commits** (per the user's standing preference).

Defaults I chose without asking (flag any you disagree with):
- Default templates: Task: `{{input}}`. Issue: `Start work on GitHub issue #{{number}} ({{url}}). When the whole issue is solved, ask me whether you may close it.`
- **Worktree setup commands under ADR-0042:** the task script runs them first, from an argument, via `eval`, then the Agent. That is the same as typing them, which is what happens today. They are author-written shell, so `eval` is correct here. The "no `eval`" rule is about *values*, not commands. A failing setup command does not stop the Agent, which matches today's typed behaviour.
- The Issues tab is hidden (with a one-line reason) when the folder is not a git repo, has no GitHub remote, or `gh` is not signed in.
- Input, note, and issue title are stripped of C0/C1 control characters (`stripControlChars`), as for Prompt action Parameters. The template itself is not stripped.

## Commits

### 1. Task-capable Agents (data + Settings badge)
- `lib/types.ts`: `CodingAgent.taskArgs?: string[]` (a form with a `{prompt}` placeholder element).
- `lib/agents.ts`: fixed `taskArgs` on the 7 built-ins. `isTaskCapable(agent)`. `agentTaskArgvFor(agents, id, prompt): string[] | undefined`, which is the single source of truth, like `agentCommandFor`. `mergeAgentsWithBuiltins` always takes a built-in's `taskArgs` from code, never from the persisted copy.
- `Settings/AgentsSection.tsx`: *Task-capable* badge. A task-argument-form input on custom Agents (validated: exactly one `{prompt}`).
- Tests: `agents.test.ts` (argv building, merge keeps code's taskArgs, custom-agent validation).

### 2. Templates + settings
- `settingsStore`: `taskTemplate`, `issueTemplate`, `taskDestinationPreference: "restart" | "newTab"`. Add them to the cross-window broadcast set.
- `lib/taskPrompt.ts` (pure): `resolveTaskPrompt({kind, input | issue, note}, templates)`. Reuse the Prompt action placeholder interpolation. Strip controls from values. Append the note as its own paragraph. `taskTabName(task)`. `suggestBranchForIssue(issue)` (slug, length cap, `git check-ref-format`-safe).
- New Settings section **Tasks**: the two templates with a placeholder legend and Reset.
- Tests: `taskPrompt.test.ts` (placeholders, empty note, ESC stripping in values but not the template, tab name truncation, branch slugs).

### 3. Launch path (Rust + terminalManager), ADR-0042
- `pty_manager::spawn`: new optional `task: Option<TaskLaunch { argv: Vec<String>, setup: Option<String> }>`. When set, build `shell` + the usual integration flags/env + `-c <TASK_SCRIPT> abundio-task <setup> <argv…>`. The script is a constant per shell type. It emits `\e]7770;command_start;<argv[0]>\a`, evals the setup, runs `"$@"`, emits `command_end;$?`, then `exec`s the same shell with the same interactive flags. Return `AbundioError::Pty` with a clear message for PowerShell, cmd and Other.
- `commands::pty_spawn` passes it through. `lib/ipc.ts` gets the typed wrapper.
- `pendingAgentRegistry`: a pending entry may carry `task` instead of a typed command. `terminalManager` passes it to the spawn instead of typing, and still calls `setAgentPty`.
- `restartPanePty` gains an optional `task` option (it respawns anyway).
- Rust tests: the argv shape for zsh/bash (the prompt is a separate element, never joined), refusal for PowerShell/cmd, and a prompt with `'`, `"`, `$(…)` and a newline survives byte-for-byte. Manual check in each shell that the wrapper rc (Injected bundle re-export) runs under `-i -c`.

### 4. GitHub issues
- `gh_commands.rs`: `gh_list_issues(cwd)` → `gh issue list --state open --limit 100 --json number,title,url,assignees,updatedAt,labels`. Sort assigned-to-me first, then newest. Reuse `run_gh` and its offline/auth messages.
- `lib/ipc.ts` wrapper. The demo gets a `mockInvoke` fixture.
- Rust test: parse and sort.

### 5. New task dialog
- `components/NewTask/NewTaskDialog.tsx`: tabs *Describe* / *GitHub issue*; the Workspace picker (Fleet only, reusing `FleetConsole/WorkspacePicker`); destination segmented control; Agent select (Task-capable + Watched only, using `PromptActions/Select`); the Restart pane picker when ambiguous; inline branch/folder for New worktree (extract `resolvePath` and the folder derivation from `AddWorktreeDialog` into a shared lib); collapsed preview. Escape via `useEscapeKey`. Padding inline, hover states in classes.
- `lib/newTask.ts` (pure): `defaultDestination`, `defaultAgentFor(workspace, focusedPane)`, `restartCandidates(workspace, focusedPaneId)`. Tests.
- Orchestration `startTask(...)`: Restart → confirm if Working/Waiting (reuse the close-guard busy check), then `restartPanePty({task})`. New tab → `createTab` with a task pending entry and the Task name. New worktree → `createWorktreeWorkspace` with the task instead of the typed agent/setup, behind the existing `WorktreeProgressDialog`.

### 6. Entry points
- Keybinding `new-task` (`Cmd+Shift+T` / `Ctrl+Shift+T`). Must not be muted by `workspaceViewOnly`. Command palette entry. Tab bar button. Sidebar row menu. Fleet Add agent choice (New agent · New task · Relaunch) and toolbar button.
- Update the `CLAUDE.md` shortcut table, and add the `NewTask/` component and `lib/taskPrompt.ts` / `lib/newTask.ts` to its file list.

### 7. Verify in the real app
- Each built-in Task-capable Agent, in zsh and bash: it starts with the prompt, stays interactive, and the status icon goes Working. When it exits the Pane is a normal shell, and an app restart does *not* re-send the Task.
- Restart on a Working Agent asks first. New worktree runs the setup commands, then the Agent. The Issues tab is hidden with no `gh` auth. Demo (`pnpm demo:web`) does not throw.
