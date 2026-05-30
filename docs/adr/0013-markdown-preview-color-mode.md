# Markdown preview follows the app theme's colours, with a "printed paper" white override

The **Preview pane** originally rendered always-light (a fixed white "printed
paper" canvas) regardless of the app theme — a deliberate choice, so a dark-theme
user got a bright white pane beside their dark editor. We reversed the default:
the preview now **adopts the active theme's actual colours** (canvas, text,
chrome, links), matching the rest of the UI, and the old always-light look is
demoted to an explicit, opt-in override. This is a single global, persisted
preference (`markdownPreviewColorMode: "auto" | "light"` in `settingsStore`,
default `"auto"`) — the **Preview color mode** — toggled from the preview's title
bar. The icon shows the *target* the click switches to: `Sun` while following the
theme (click → white paper), `Monitor` while on white (click → follow theme).

## How "follow theme" works

`@uiw/react-markdown-preview` renders against a GitHub-palette set of CSS
variables (`--color-canvas-default`, `--color-fg-default`, `--color-accent-fg`,
…) selected by a `data-color-mode` light/dark base. In follow-theme mode we:

1. set `data-color-mode` to the active theme's `variant` (so the library's base —
   including code-syntax token colours — is light/dark-appropriate), and
2. **override the surface variables** with Abundio's theme variables
   (`--bg-primary`, `--fg-primary`, `--border`, `--accent`, …) via a
   higher-specificity rule in `PreviewPane.css`, gated by a `data-themed`
   attribute on the container.

So on Solarized Dark the preview canvas is Solarized's background, its text
Solarized's foreground, etc. The forced-`light` mode skips the overrides entirely
and shows @uiw's untouched white palette.

## Scope: surface only (option i)

We remap the document **surface** — canvas/code backgrounds, body and muted text,
borders, blockquotes, links, danger/success accents — but **not** the
`--color-prettylights-syntax-*` code-token colours, which stay at @uiw's
light/dark defaults. Abundio's themes define a UI palette and a terminal ANSI
palette, not a full editor syntax-highlighting palette, so faithfully recolouring
every token isn't possible; code blocks sit on a theme-coloured surface with the
library's (legible) token colours. Matching exact syntax tokens (option ii) was
rejected as fragile and often worse-looking.

## Considered options

- **Follow the light/dark *variant* only** (one fixed GitHub-dark look for every
  dark theme) — rejected after initial implementation. It reads the theme's
  variant but ignores its colours, so a Solarized-Dark or Dracula user gets a
  generic `#0d1117` preview that clashes with their UI. The intent was always to
  *match the theme's colours*, not just its darkness.
- **Three-state cycle (`auto → light → dark`)** — rejected. The realistic need is
  "occasionally want white paper"; a forced-*dark* state adds nothing, since dark
  previews already arise from any dark theme. The model stays a clean binary with
  no `"dark"` value.
- **Per-pane / per-file override** — rejected. Per-pane would add a field to the
  `PaneNode` shape and force a layout migration (see ADR-0001). A single global
  preference matches how `theme` itself works.

## Consequences

- The override is a true binary that can return to `auto` — no pinned-forever
  dead end.
- On a **light** app theme the two states look similar (themed-light vs pure
  white) but aren't identical; the toggle is most meaningful on dark themes.
- **Print** is unaffected: it always renders on white paper regardless of this
  preference.
- Mermaid diagrams always render with the light theme; in a dark-surface preview
  they sit on a white card (`PreviewPane.css`) so they stay readable.
- Adding/removing a theme variable consumed by the preview means revisiting the
  `[data-themed]` override block.
