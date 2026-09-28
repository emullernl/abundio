# OpenCode 2 status comes from a TUI plugin, not a server plugin

OpenCode 2.x runs every `opencode` TUI against one shared background server (`opencode serve --service`), and server plugins run inside it. Abundio's plugin finds its Pane through `ABUNDIO_PTY_ID` / `ABUNDIO_HOOK_PORT` / `ABUNDIO_HOOK_TOKEN`, but in a server plugin those are the *server's* environment — set once by whichever process started it, stale after Abundio restarts — so a server plugin would send every Pane's events to one Pane, or to none. We therefore ship the 2.x hook as a **TUI plugin** (an Abundio-owned folder, `~/.config/opencode/plugins/abundio/`). It runs in the Pane's own process with the Pane's own environment, and it is the only place that knows which session is on screen. It classifies each event as the pane's own session, a Subagent of it, or foreign (dropped) before posting. The status-mapping table stays in the frontend, like every other Agent's.

## Considered Options

- **Launch OpenCode with `--standalone`** (a private server per Pane, so the 1.x environment trick keeps working). Rejected: it opts Abundio's panes out of 2.x's shared service, and a user typing `opencode` by hand in a Pane silently gets no status.
- **Abundio subscribes to the server's event stream directly** (no plugin). Rejected: it needs the service password from `~/.local/state/opencode/service.json` and a long-lived connection that survives service restarts, and it *still* cannot tell which Pane shows which session — only the TUI knows that.

## Consequences

- OpenCode 1.x and 2.x need different plugins, so Hook provisioning detects the major version (`opencode --version`, cached per binary path and modification time). On 2.x it deletes Abundio's own 1.x file, because 2.x refuses to load it and shows a "Server plugin error" to the user.
- The TUI plugin API is beta. Abundio depends on as little of it as possible: `data.on`, `app.router.current`, `data.session.root` and `data.session.status`. The plugin must import nothing, because bare package imports do not resolve for plugins OpenCode finds by itself on disk.
