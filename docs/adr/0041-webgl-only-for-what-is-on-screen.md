---
status: accepted (narrows the context-holding part of ADR-0002)
---

# WebGL contexts go to what is on screen, plus the Tab just left

A terminal only holds a WebGL context while it is on screen, with one exception kept warm for switching back. In the **Workspace view** that is the visible Tab's panes plus the previously visible Tab (whether it was left by a Tab or a Workspace switch). In the **Fleet Console** it is the spotlighted tile alone: grid tiles, Filmstrip tiles and the hidden Workspace view all draw with xterm's DOM renderer. Everything else gives its context up and gets one back when it becomes visible again. The cap of 12 (`MAX_WEBGL_CONTEXTS`) still applies, and the GPU acceleration setting still overrides all of this.

ADR-0002 and `webglBudget.ts` held a context on every pane of every opened Workspace, up to the cap, so switching never rebuilt them. That spent contexts on panes nobody could see, and a Fleet Console showing a dozen agents at once pushed the page past Chromium's limit of 16 — the browser then evicts the oldest context and leaves that terminal a blank canvas. Drawing only what is visible keeps the count to a handful whatever the number of opened Workspaces.

## Considered options

- **Keep holding contexts across opened Workspaces.** Instant switching everywhere, but contexts go to hidden panes and the Console overflows the limit. Rejected.
- **Strictly visible only.** Fewest contexts; but every switch pays the rebuild, including the common back-and-forth between two Workspaces. Rejected for the one-Tab warm memory.
- **Keep the hidden Workspace view warm behind the Console.** Makes closing the Console instant; rejected so that in the Console the spotlighted tile is the only GPU terminal.
- **WebGL on the Focused tile in the Console grid.** Every focus change would swap two renderers, a visible repaint on each click. Rejected.

## Consequences

- Switching to a Tab that is neither visible nor the one just left rebuilds its contexts: measured ~85 ms for one pane and ~260 ms for eight (see `webglBudget.ts`). For a moment those panes draw with the DOM renderer, then WebGL takes over.
- Opening the Console, spotlighting a tile and closing the Console each swap renderers on the panes involved.
- The WebGL glyph atlas is shared between terminals with the same configuration, so a renderer change must never clear it through one terminal alone (see `clearGlyphCaches`).
