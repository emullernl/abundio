# Opened workspaces are layered absolutely, not flex-stacked

Opened workspaces share one area as absolutely-positioned siblings inside the
main content region (`App.tsx`). Only the active workspace has
`visibility: visible`; background workspaces have `visibility: hidden` +
`pointer-events: none`. The previous implementation used `display: none` to hide
background workspaces inside a normal flex column. We switched because warm
workspace switches felt laggy on click — `display: none → flex` forced a fresh
layout + paint of the becoming-visible workspace's entire subtree on every
switch (xterm DOM, WebGL canvases, the lot), even when the destination was a
workspace the user had just left. `visibility: hidden` preserves the layout box
of background workspaces, so flipping back to one is effectively a `paint:
revisible` rather than a relayout.

## Consequences

- Background workspaces continue to pay paint cost when their PTYs emit output —
  xterm's WebGL renderer keeps drawing into hidden canvases via
  `requestAnimationFrame`. Negligible for idle background workspaces; measurable
  for ones running a streaming agent. We accepted this cost because the common
  case is idle backgrounds and instant switching matters more.
- Code that distinguishes "the active workspace's DOM" from "any opened
  workspace's DOM" can no longer rely on `offsetWidth === 0` for the inactive
  ones (layout is preserved). The active workspace wrapper carries
  `data-workspace-active="true"`; selectors that need the active subtree must
  scope to that attribute (see `dragPaneHitTest.ts`).
- The workspace wrapper is no longer a flex child of the main content column.
  Its `top` is set to `TITLEBAR_HEIGHT` because absolute positioning ignores its
  containing block's `padding-top`. If the titlebar height ever becomes dynamic,
  the offset and the parent's `paddingTop` must change in lockstep.
