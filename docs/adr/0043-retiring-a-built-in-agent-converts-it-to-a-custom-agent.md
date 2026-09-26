# Retiring a built-in Agent converts it to a custom Agent with the same id

Aider was dropped from the built-in Agents (#204). It has no hook system, so it only ever got heuristic status. Built-ins are merged from code on every settings load (`mergeAgentsWithBuiltins`), so simply deleting it from `BUILTIN_AGENTS` would silently erase it from every user's settings. Saved Panes that last ran Aider would reopen as plain shells, and prompt-action scopes and Statistics history would point at an Agent that no longer exists. All of those key on the Agent id, `"aider"`.

We keep the Agent for users who use it:

- **The rule lives inside `mergeAgentsWithBuiltins`.** A persisted built-in whose id is in `RETIRED_BUILTINS` becomes a custom Agent (`builtin: false`) with the **same id**, marked `retiredBuiltin: true`, when it was **Watched**. When it was not Watched, it is dropped. The rule is pure and idempotent, and every settings load path (the synchronous first-render read, persist `migrate` and persist `merge`) already runs this function, so they all agree.
- **A one-shot settle after a real `$PATH` scan.** ADR-0037 left users from before Agent seeding with every built-in Watched, so "Watched" does not imply "Installed". After the startup scan, `pruneRetiredBuiltins` **un-Watches** every marked Agent whose command is not Installed, and clears the marker on all of them. It only settles Agents whose command that scan actually looked up (`scannedCommands`). An empty scan is a failed scan and changes nothing, and it runs only when the scan used the real login-shell `$PATH` (`agents_path_is_resolved`): when the shell times out, the fallback `$PATH` can find Homebrew agents yet miss one in `~/.local/bin`, where Aider is usually installed. It runs on every launch until nothing carries the marker, independent of the one-time seeding claim. A hand edit (`updateAgent`) also clears the marker: the user now owns the Agent.
- The Aider icon and Statistics colour and label stay, keyed on the id, for the converted Agent and old Turns.

## Considered options

- **A persist `migrate` step (settings v12).** Runs after the synchronous first-render read and `merge` have already called `mergeAgentsWithBuiltins`, which would drop the Agent first. In that gap, `seedPendingAgentsForLayout` could start saved Aider Panes as plain shells. Rejected.
- **Convert only if Installed.** The scan is async, so on the first launch saved Panes would open as plain shells before it lands. Rejected.
- **A fresh `custom-<uuid>` id.** Would need a data migration of layouts, prompt-action scopes and `agent_turn` rows. Nothing depends on the `custom-` prefix, so the old id is kept. Rejected.
- **Plain drop.** Loses the user's Agent and orphans saved Panes. Rejected.
- **Delete the converted Agent when it is not Installed**, instead of un-Watching it. "Not a file on the login-shell `$PATH`" is narrower than "not used": a venv or conda install, a `~/bin` added by a directory hook, or a shell-function wrapper all read as not Installed, and deleting loses the Agent and anything the user set on it with no undo. An un-Watched Agent is already absent from every launch menu and from hook provisioning, so un-Watching reaches the same visible result and stays reversible. Rejected.

## Consequences

- A custom Agent can have an id without the `custom-` prefix. Code must not use the prefix to tell custom Agents apart; use `builtin`.
- A user who never had Aider installed keeps one un-Watched "Aider" row in Settings ▸ Agents, which they can remove.
- A user who had both the Watched built-in and their own custom Agent with command `aider` ends up with two entries with the same command. Accepted: the user's own one is never touched, and they can remove either.
- A user who deletes the converted Agent loses it for good: it is no longer persisted as a built-in, so the merge never re-adds it.
- Hooks are unaffected: Rust already treats `aider` as unsupported, like any custom Agent.
- Retiring another built-in later means adding it to `RETIRED_BUILTINS`; nothing else changes.
