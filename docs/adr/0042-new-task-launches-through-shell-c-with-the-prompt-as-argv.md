# A New task starts its Agent through `shell -c`, with the prompt as a separate argument

Every other Agent launch types the launch command into a running shell (`pendingAgentRegistry`, the Command palette, Relaunch). A **New task** does not. It spawns the Pane's PTY as the user's login-interactive shell running one fixed script, and passes the Agent's command and the resolved **Task** prompt as *separate arguments* after it:

```sh
zsh -l -i -c '<abundio task script>' abundio-task claude "<resolved prompt>"
```

The script runs `"$@"`, then `exec`s a normal interactive shell, so the Pane becomes an ordinary terminal once the Agent exits. The prompt never goes through the shell's parser. It arrives in the Agent's `argv` exactly as written, so quoting, newlines and anything in an issue title are harmless by construction. It also never enters shell history or the environment. The user's rc files still load (`-l -i`), so an Agent found only through `.zshrc` (nvm, asdf, an exported API key) behaves as it does when typed by hand.

Shell integration never sees a command that did not come from the prompt, so the script emits its own `command_start;<agent>` before the Agent and `command_end;$?` after it, on the existing `7770` channel. Agent-mode enter and leave then work unchanged, and an exited Task Agent is forgotten instead of auto-relaunching.

## Considered options

- **Type a quoted command** (`claude '<escaped>'`). Simplest, but the prompt lands in shell history, and any escaping mistake with issue text is shell injection. Rejected.
- **Environment variable** set on the fresh PTY, then type `claude "$ABUNDIO_TASK"`. Uses the existing typed path and needs no quoting, but the prompt lingers in the shell and every child process until the Pane restarts. Rejected.
- **Temporary file** plus `claude "$(cat file)"`. Nothing lingers in the environment, but the file needs cleanup, has a window where it could be read, and needs a different substitution form for each shell. Rejected.
- **Run the Agent binary directly as the PTY's program.** Fully portable, but it skips the user's rc files, and the Pane dies with the Agent. Rejected.

## Consequences

- Supported shells: zsh, bash, fish (whose `-c` receives the trailing arguments in `$argv`). PowerShell and cmd.exe are refused with an explanation for now. PowerShell could later use `-File <script> <agent> <prompt>` in the same shape.
- The prompt is part of the spawn, not of the Pane's remembered state. Auto-relaunch and **Relaunch** run the Agent's plain command and never re-send a Task.
- The `-c` shell keeps the same `-i` and wrapper redirection (`ZDOTDIR`, `--rcfile`) as a normal spawn, so the wrapper rc still runs before the Agent. That includes the Injected bundle's shadow-variable re-export. This must be verified for each supported shell, because "interactive plus `-c`" is the least-used corner of each shell's startup rules.
