---
status: accepted
---

# Prompt action attachments travel by path, not by clipboard

An attachment on a **Prompt action** reaches the **Agent** as a **file path interpolated into the prompt text**. Abundio writes the file to disk, puts its path where the placeholder was, and sends the whole thing as one bracketed paste. The OS clipboard is never written and no `Ctrl+V` is synthesised.

This is the opposite of what **Smart image drop** does for what looks like the same job, which is the only reason this ADR exists.

## Why Smart image drop does it the other way

Dropping a single image file on an agent-mode pane writes the PNG to the OS clipboard and sends the Agent a `Ctrl+V` byte (`0x16`), so the Agent ingests it through the same path it uses for a real paste. That is the right call *there*: the user's gesture was "put this picture in", there is nothing else in flight, and an agent's clipboard-image path is the best-trodden one it has.

It also has two costs that CONTEXT.md already flags: it clobbers the user's clipboard and never restores it, and it fires for every agent-mode pane whether or not that Agent can read a clipboard image at all.

## Why a Prompt action cannot afford those costs

A Prompt action is not a bare image. It is **text with an image in it**, and usually several other parameters besides. Reusing the clipboard route turns one click into a sequence with no acknowledgement anywhere in it:

set clipboard → send `Ctrl+V` → wait an unknowable interval for the Agent's TUI to ingest the bitmap → paste the body text → send `\r`.

There is nothing to wait *on*. The Agent never tells us it finished ingesting, so the wait is a guess, and a guess that is too short interleaves the body text into a half-finished paste. Beyond the race, the clipboard route caps an action at one attachment and cannot carry a non-image file at all — both of which the feature is required to do.

## What the path route buys

Making the attachment a path collapses the whole action back into the shape every other Prompt action already has: **one bracketed paste, one `\r`** (see the **Prompt action** entry in CONTEXT.md). From that follows:

- **No clipboard clobber.** The user's clipboard is not ours to spend.
- **No timing race.** The path is inert text; it arrives in order with everything around it.
- **N attachments**, because a path is just more text.
- **Non-image files for free** — a PDF, a log, a CSV. A clipboard cannot carry those to an Agent at all.

The trade is that the Agent must be willing to open a file it is handed. Every Agent Abundio supports is a coding CLI whose entire job is reading files by path, so this is a weaker assumption than the one Smart image drop makes about clipboard-image support.

## A pasted image has to become a file

The parameter dialog's **Paste from clipboard** button, given an image rather than a copied file, yields a bitmap with no path, so Abundio materialises it: Rust reads the clipboard and writes a PNG under `app_paths::versioned_root()/prompt-attachments/`, named by content hash. This is the part with no clean answer — **nothing owns the file's lifetime**. The Agent may open it immediately, or in ten minutes, or never, and it may quote the path into its own transcript long after.

So the directory is treated as a **cache, not as user data**: content-hashed names make re-pasting the same image free, and a sweep at startup drops anything older than a set age. The sweep is deliberately far past any live **Turn** — an attachment still being read hours later is a case we accept losing rather than a case we try to track. It lives under the versioned root because it is epoch state an older build has no business reading (ADR-0025).

## Consequences

- Two mechanisms now exist for "get an image to an Agent", and they disagree. The dividing line is whether the image arrives **alone** (clipboard, Smart image drop) or **inside a prompt** (path, here). Anything new should say which side it is on.
- `prompt-attachments/` is the first directory Abundio sweeps on a timer. If a second appears, the sweep wants to become shared machinery rather than a second copy.
- An Agent that genuinely reads clipboard images better than file paths would be evidence against this, and we have no measurements. If one shows up, the fix is a per-Agent capability flag, not a return to synthesising keystrokes.
