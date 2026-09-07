---
status: accepted
---

# Mouse reporting is refused by default

A terminal pane refuses, by default, to hand the mouse to the program running in it. The refusal is a swallowed DECSET, taken before xterm ever sees it. Where the refusal is lifted, the program gets the **whole** mouse including the right button — which reverses the contract #170 shipped — and the pane context menu moves to a permanent button in the pane's title bar so it stays reachable regardless.

See the **Mouse-reporting pane**, **Mouse-blocked pane** and **Mouse badge** entries in CONTEXT.md.

## Why refuse at all

A program takes the mouse by printing `CSI ? 1000 h` and friends. Nothing about that is negotiated: it prints, xterm flips `mouseTrackingMode`, and from that moment every click — and under `1003`, every *movement* — is forwarded to the PTY as a report. xterm hands its own selection service over for the duration.

#170 discovered how much that costs, and paid for it twice. A pane running the GitHub Copilot CLI, which asserts `1003` at startup and never releases it, could not be selected from at all. Worse, a right-click aimed at **Copy** destroyed the selection it was about to copy: the report goes out through `triggerDataEvent(report, true)`, the `true` marks it user input, and xterm's `SelectionService` clears on user input. Movement alone did it — merely travelling toward the right-click position under `1003` emitted `ESC[<35;…M` and the selection was gone before the click landed.

#170's fixes were three guards, and they are the right fixes *given* that the program has the mouse: `macOptionClickForcesSelection` for modifier-drag, withheld pointer movement while a selection is up, and a stolen right button. But every one of them is a workaround for a decision the user never made. Refusing the DECSET addresses the cause instead. In a refused pane `mouseTrackingMode` never leaves `"none"`, so all three guards stand down on their own and ordinary click-drag selection, right-click and link hover work the way they do in any other pane.

**The default is refuse.** Selection and right-click are used constantly and by everyone; a TUI's mouse support is used occasionally and mostly by people who know they want it. The setting is *Block mouse reporting* under Settings ▸ Terminal.

## How the refusal works

`Terminal.parser.registerCsiHandler({ prefix: "?", final: "h" })` runs before xterm's own DECSET handler and, returning `true`, stops it. `lib/mouseReporting.ts` holds the mode numbers and the predicate.

**DECSET is intercepted; DECRST never is.** The asymmetry is deliberate. Blocking the disables too would look tidier and would be strictly worse: a mode that slipped through as part of a mixed sequence could then never be turned off, and the pane would report for the rest of its life. Letting `l` through also gives us a free, honest signal that the program has released the mouse, and lets us sweep the modes off by writing DECRSTs into xterm when a pane is blocked while already reporting.

**`1004` is not blocked.** Focus reporting is not the mouse — no coordinates, fires on window focus, and TUIs use it to redraw a cursor. Blocking it would break those redraws for nothing.

## Lifting the refusal is per pane

The setting seeds the default; the **mouse badge** in the title bar flips one pane against it, in either direction. Not persisted — a pane starts from the setting again after a restart of the app.

This needs a **replay**, or the control is a lie. A program asks for the mouse exactly once. Swallow that request, lift the block a minute later, and nothing happens: tmux is not going to ask again. So a blocked pane remembers the mode numbers it refused and re-issues them as real DECSETs the moment it is unblocked. The same problem applies to the global setting, which is why unticking the box in Settings replays across every live pane rather than taking effect on the next program launch.

A per-pane override **survives a PTY restart**, including the pane menu's *Reset Terminal*; the refused-modes memory does not. The override is a decision about the pane, and restarting to pick up an Environment Bundle (ADR-0023) should not silently revoke it. The memory is a fact about a program that no longer exists. `restartPanePty` reuses the same `ManagedTerminal`, so this is explicit teardown, not something `term.reset()` does for us.

## The right button follows the mouse

In a pane that is reporting, the right button now reaches the program. #170 kept it for Abundio and offered *Send Right Click to Terminal* as an escape hatch; both that item and the button-2 guard are deleted.

The reversal is only defensible because of the two decisions above. Refusal-by-default means a reporting pane now exists **only** where someone deliberately turned the block off — and essentially the only reason to do that is to give a TUI the mouse, which includes its right button. And the pane context menu is no longer reached by right-clicking, so nothing is lost when the right button leaves.

The `contextmenu` capture handler stays regardless of who owns the button, and keeps its `preventDefault()` + `stopPropagation()` unconditionally. That is not about our menu: xterm's own `contextmenu` listener moves its hidden textarea under the cursor, which on Windows WebView2 pastes the clipboard straight into the PTY. It merely stops calling `setContextMenu()` when the pane is reporting.

## The pane menu button is permanent

A `⋯` button sits left of *Split Down* in every pane's title bar, always, not only when a pane is reporting. Conditional presence would shift *Split Down*, *Split Right* and *Close* by 22px under the cursor every time a program grabbed or released the mouse — and Copilot toggles `1003` around its own prompts. It would also make the only path to the menu appear exactly when the pane is at its busiest. `TerminalTitleBar` is rendered unconditionally by `TerminalSlot`, so this button is the guarantee that the pane menu is always reachable.

## Consequences

- **On the alternate screen, the wheel walks the prompt in an agent TUI.** With reporting off, xterm translates wheel ticks into cursor keys — which is why scrolling works in `less` and `man`. In Claude Code or Copilot CLI, sitting on the alternate screen with an input focused, those arrows navigate prompt history: scroll to re-read something and your typed prompt is replaced. Accepted knowingly. It is what plain xterm, iTerm2 and Ghostty all do, and unlike them we put a one-click fix in the title bar — the badge hands that pane its mouse back. Suppressing the wheel in panes that asked and were refused was considered and rejected as a special case that would have to be explained forever.
- **A mixed DECSET fails open.** The parser hook returns one boolean for the whole sequence; there is no supported way to apply some parameters and drop the rest. So `CSI ? 1049 ; 1002 h` passes through untouched and the program gets the mouse. Swallowing it instead would drop the alternate-screen switch and leave a full-screen TUI painting over the shell's scrollback — a visible, unrecoverable mess, against a failure mode that is merely the behaviour of every previous release. Mixing is in any case vanishingly rare: ncurses, tmux, vim and the agent TUIs all emit mouse modes in sequences of their own.
- **#170's guards are dead code in the default configuration and must stay anyway.** They are the entire reason a reporting pane is usable, and the movement guard is now *more* load-bearing than when it was written: the walk from a selection to the `⋯` button is longer than the walk to a right-click, and every step of it under `1003` would clear the selection. `TerminalTitleBar` renders inside `containerRef`, so the existing capture-phase listener already covers that journey.
- **Programs cannot detect the refusal.** DECRQM reports the mode as reset, because it is. A TUI that queries before drawing will correctly conclude it has no mouse; one that assumes will draw affordances that do nothing. There is no way to tell it otherwise, and no reason to want one.
- **The block is a frontend decision.** Rust and the PTY know nothing about it. `TERM` is unchanged, so a program still advertises mouse support in its terminfo and still tries.
