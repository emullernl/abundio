---
status: accepted
---

# The Orchestrator folder can be chosen by the user

ADR-0057 put each Profile's **Orchestrator workspace** in a folder Abundio owns, `<data>/abundio/orchestrator/<profile-id>/Orchestrator/`, and rejected a user-chosen folder. In use, the id in that path is noise (the Agent prints its folder on every start), and users want the Orchestrator's files, notably `my-instructions.md`, somewhere they keep their own things.

We decided that the **Orchestrator folder** is a per-Profile setting. The default is still inside the app's data folder, but named after the Profile (`orchestrator/<Profile name>`, fixed when made, so a rename never moves it), and the user may choose another in Settings ▸ Profiles. ADR-0057's worry, a visible folder gets moved or deleted, is met by recreating a missing Orchestrator folder when its parent exists and otherwise asking (never starting elsewhere, as ADR-0053 requires). The rest of ADR-0057 stands.

## Considered Options

- **Any folder, merging Abundio's instructions into an existing `AGENTS.md`/`CLAUDE.md`.** Rejected: Abundio rewrites those on every start, so a project repo's own files would change under the user. Only an empty folder, or one Abundio already set up (it leaves a marker), may be chosen.
- **Renaming the default folder with the Profile.** Rejected: an Agent keeps its conversation history per folder, so every rename would start the Orchestrator over.
- **Moving existing installs to the new name.** Rejected for the same reason: they keep their id path until the user chooses a folder.

## Consequences

- Changing the folder starts a new Orchestrator conversation; the confirmation says so.
- Deleting a Profile deletes its default folder, never a chosen one.
