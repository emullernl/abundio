# Abundio product tour

A self-contained, animated 16:9 presentation of Abundio, styled after the
marketing website (`~/personal-dev/abundio-website`): same palette, JetBrains
Mono, glass frames, mesh-gradient backdrop.

Every "screenshot" is actually a live HTML/CSS recreation of the app UI —
terminals stream their transcripts line by line, agent status dots spin /
pulse / bounce / shake exactly like the app's `AgentStatusIcon` states, panes
split in real time, diffs stream in, the command palette types its own query,
and notes tick themselves off. The status-dot states, overview-bar tiles,
workspace rows and transcript content are all lifted from the real app
(`AgentStatusIcon.tsx`, `OverviewBar.tsx`, `WorkspaceItem.tsx`,
`src/lib/demo/transcripts.ts`).

## Playing / recording

Open `index.html` in a browser (no server needed). The stage is a fixed
1920×1080 canvas, letterboxed to the window, so any window shape records as
clean 16:9.

| Key | Action |
|-----|--------|
| `f` | Fullscreen |
| `space` | Play / pause (starts the auto-run) |
| `← →` | Jump between scenes manually |
| `r` | Restart from the title and auto-play |
| `p` | Toggle the progress bar |

To record: fullscreen on a 16:9 display, start a screen recording, press `r`,
and let it run (~107 s, ends holding on the closing frame). The mouse cursor
and the controls hint auto-hide.

## Scenes

1. Title
2. One window — full mock app: sidebar, overview bar, tabs, agent + 2 shells, status bar
3. AI agents — tab strip auto-cycles Claude → Copilot → Gemini → Codex, each with its live status dot
4. Fleet — overview bar tiles + workspace grid with per-state animations
5. Splits — pane splits choreographed live with ⌘⇧V / ⌘⇧H callouts
6. Editor & explorer — file tree + syntax-highlighted editor with the guarded lines highlighted
7. Git & GitHub — changed files, streaming diff, PR cards with pulsing CI dots
8. Navigation — ⌘K and ⌘P palettes typing their own queries
9. Markdown & notes — source/preview side by side + notes checking themselves off
10. Closing CTA

## Editing

Everything lives in `index.html`:

- Scene timing: `data-dur` on each `<section class="scene">`.
- Mock UI content (transcripts, workspace rows, diff lines, PR cards, tree,
  palette rows): the data arrays at the top of the `<script>` block.
- Per-scene live behaviour (tab cycling, split choreography, palette typing,
  note ticking): the `HOOKS` map keyed by scene id.
- Status-dot states: the `STATES` map + `--st-*` CSS variables.

Assets: `assets/abundio-mark.png` (logo), `assets/agent-icons/*.svg` (from the
website repo), `assets/fonts/` (JetBrains Mono woff2 from
`@fontsource/jetbrains-mono`).
