# A secret's first four characters are shown without a reveal

The settings list for Environment Bundles used to render every value as `•••••••• · 64 B`. The mask was deliberate: plaintext never reaches the frontend except through `env_vars_reveal`, one variable at a time, on an explicit expand. But it made the list less useful than it looks. Two tokens pasted into the wrong Bundle are indistinguishable when both read `•••••••• · 64 B`, and the only way to catch the mistake was to reveal each row in turn — which put the whole secret on screen anyway.

So the collapsed row now shows the first four characters: `sk-l•••••••• · 64 B`. That is a deliberate, bounded break of the plaintext invariant, and it is recorded here because a future reader will otherwise reasonably assume it was an oversight.

## Considered Options

- **Keep the mask, add a hover tooltip with the prefix.** Rejected: the mistyped-Bundle case is one you only notice by scanning the list, and a hover per row is the same work as expanding the row.
- **A configurable prefix length in Settings.** Rejected: the setting would be global while the values are per-Workspace, so it would answer a question nobody asked in the place the user is looking.
- **Reveal the first four characters through a separate IPC per row.** Rejected: `vars_of` already decrypts every row to compute `undecryptable`, then discards the plaintext. Taking four characters from that same open costs one extra field and no extra keychain work.
- **Show the prefix in the expanded editor only.** Rejected: by then the whole value is on screen, so there is nothing left to protect.

## Consequences

- `EnvVarMeta.prefix` is the only plaintext that enters the frontend without a reveal, and it is capped at four characters. The single `revealed` slot is still the only place a full value can live, and `workspaceEnvStore`'s plaintext comment says so.
- **Export never touches the frontend.** `env_export_to_path` resolves *and* writes the file in Rust; the save dialog supplies only a path. Looping `env_vars_reveal` over a Bundle would have put every secret of it in the JS heap at once, which is exactly what the single slot exists to prevent.
- The prefix is withheld rather than guessed: `None` when the value is four characters or shorter (a short secret has no safe prefix), when it starts with whitespace or a control character (it would render as an empty prefix, which looks like a bug), or when the row will not open. It is counted in Unicode scalar values, not bytes, or a non-ASCII secret would show a replacement glyph.
- Inherited rows show their prefix too. The linked worktree is already a place those values are usable from, and the list deliberately does not have two row behaviours for one-looking rows.
- An empty value is now a real state rather than a blocked one: the add form accepts it, it is written as `NAME=""`, and the row reads `(empty)` — because `0 B` beside eight dots looks like a row that failed to load.
- The export file is `NAME="value"` per line via `hook_server::quote_dotenv_value`, the same function `abundio-env print` uses, so both round-trip through `parseDotenv`. One difference from `print`: export writes **own rows only**, so a linked worktree's export never carries the primary's secrets. An unreadable row fails the whole export rather than producing a file quietly missing a secret.
