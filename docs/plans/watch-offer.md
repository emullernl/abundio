# Watch offer

An Agent installed after **Agent seeding** ran stays un-Watched, so Abundio ignores it: no hooks, no agent mode, not in the launch menus. The **Watch offer** (`GLOSSARY.md`) asks about it the moment the user types it into a pane. And an Agent that is Watched but was installed later gets its hooks the moment it is typed, as a launch from the menu already does.

## Decisions

- **Trigger**: a typed command (shell integration's `command_start`) that names a built-in Agent which is not Watched, not declined (*Never*) and not snoozed (*Not now*). Custom and retired Agents never trigger one.
- **Yes** turns the Agent's Watched toggle on: hooks (when the Status Hooks setting is on), the skill, menus, detection.
- **Restart**: the banner offers *Enable and restart (new session)* next to *Enable (next start)*. With no hooks yet there is no Agent session id, so a restart cannot resume.
- **Not now** (and closing the banner): no offer for that Agent until Abundio next starts, in any Window. Kept in memory by the Host.
- **Never**: per Agent, in the **Host settings** (`declinedAgents`). Settings' Watched toggle still works; *Match toggles to installed agents* clears the list.
- **Status Hooks off**: the offer still shows, worded without status tracking.
- **Every pane** running the Agent shows the banner; one answer closes them all.
- **Watched but not provisioned, typed**: Rust writes its hooks then and there (`ensure_agent_hooks`). If it wrote anything, the pane offers only *Restart to start tracking (new session)*.

## Where it runs

Rust sees every typed command where the PTY runs (`shell_integration::listen`), so it decides and raises the offer:

1. `AgentCommands` (core) also holds the offer state: whether hooks are on, the declined Agents, the snoozed ones. A Window sets the first two for this computer with the Agent list (`agent_commands_set`); a server takes them from its Host settings (start and `host_settings_set`).
2. On `command_start`, `AgentCommands::offer_for(text)` answers:
   - an un-Watched built-in, not declined or snoozed → `watch-offer` `{ ptyId, agentId, kind: "watch" }` to the PTY's Windows;
   - a Watched built-in, hooks on → `ensure_agent_hooks` on its own thread; if it provisioned → `watch-offer` `{ kind: "restart" }`.
3. `watch_offer_close { agentId, snooze }` (host command): snoozes the Agent when asked, and broadcasts `watch-offer-closed { agentId }` so every Window drops its banners.

The Window:

4. `settingsStore.declinedWatchOffers` (this computer's Host settings, mirrored into the database like the Agent list); a joined or remote Host's are written with `host_settings_set`.
5. `watchOfferStore`: pane-keyed offers from `watch-offer`, cleared by `watch-offer-closed`, by the Agent becoming Watched, and by the pane closing.
6. `WatchOfferBanner` between the pane's title bar and terminal.
7. Enable: the Host's Watched toggle (`toggleAgent` here, `host_settings_set` + provisioning on a Host), then `watch_offer_close`. Restart: `restartPaneWithAgent` (fresh start of the Agent's command, in the pane's live folder).

## Commits

1. Rust: offer state, `offer_for`, `watch-offer` / `watch-offer-closed`, `watch_offer_close`, the silent hook write, Host settings' `declinedAgents`. Tests.
2. Window: store, banner, actions, sync of the declined list, IPC, command scope, demo mock. Tests.
3. Docs: glossary, CLAUDE.md.
