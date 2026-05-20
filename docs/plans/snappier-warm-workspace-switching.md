# Make warm workspace switching feel instant

## Context

Switching between **opened workspaces** (workspaces already in `usePtyActivityStore.openedWorkspaceIds`) feels laggy on click. The lag is:

1. **Warm switch only** — the cold path (`beginWorkspaceSwitch`'s slow path at `workspaceStore.ts:457–467`) is already overlayed and behaves acceptably. The complaint is specifically the fast path where `setActiveWorkspace(id)` runs synchronously.
2. **"Click feels delayed before anything happens"** — the gap is between the click and the first visible change, not between visible change and interactivity. That points to work that runs *before* the next paint.
3. **Roughly constant regardless of size** — the destination workspace's layout complexity and the total opened-workspace count don't visibly change the felt lag. Rules out per-pane reflow (xterm FitAddon, WebGL context restore on many panes) and subscriber count effects.
4. **Independent of git panel state** — collapsing the git changes panel does not make switching feel snappier. Rules out `GitChangesPanel` and `PullRequestsSection` DOM cost as the dominant factor (though `useGitDataSync.ts:170–171` still calls `clear()` on the singleton stores synchronously on every switch — see follow-ups).

Given those constraints, the live hypotheses for the constant per-switch cost were:

- **(A) Browser layout/paint cost of `display: none → flex`** on the becoming-visible workspace's subtree. xterm DOM trees, WebGL canvases, and many child elements get re-laid-out on every flip.
- **(B) React subscriber-cascade** from the Zustand `set()` inside `setActiveWorkspace` (`workspaceStore.ts:402–434`). Many components subscribe to `activeWorkspaceId` and/or `workspaces`. They reconcile in one synchronous commit before the browser can paint anything.
- **(C) xterm refit on becoming visible** — `ResizeObserver` fires for an element going from `display: none` to a sized layout, triggering `FitAddon` + WebGL activity.

We picked (A) as the highest-leverage first attempt: it's the only one where flipping a CSS property structurally removes per-switch work, and (B)/(C) are partly downstream of (A).

## Approach

Replace the `display: none ↔ flex` toggle on opened workspaces with a layered, absolutely-positioned stack governed by `visibility`. All opened workspaces are siblings inside the existing `relative` content region (`App.tsx:487–489`), positioned `absolute` with `inset` matching the titlebar offset. Only the active workspace has `visibility: visible` + `pointer-events: auto`; background workspaces have `visibility: hidden` + `pointer-events: none`.

Why this helps: `visibility: hidden` preserves the layout box. Flipping back to a previously-active workspace becomes a "paint: revisible" rather than a full relayout + paint of an xterm-heavy subtree. xterm + WebGL state survives across switches.

Trade-off accepted: a background workspace whose PTY emits output continues to drive `requestAnimationFrame` updates into its (invisible) xterm WebGL canvas. Negligible for idle background workspaces; measurable but bounded for ones streaming an agent. Captured in ADR-0002.

## Files modified

### `src/App.tsx`

Workspace map in the content region (lines 509–566). Changed each workspace wrapper from:

```tsx
<div
  key={workspace.id}
  className="flex-1 min-h-0 flex flex-col"
  style={{ display: isActive ? "flex" : "none" }}
>
```

to:

```tsx
<div
  key={workspace.id}
  data-workspace-active={isActive ? "true" : undefined}
  className="absolute flex flex-col"
  style={{
    top: TITLEBAR_HEIGHT,
    left: 0,
    right: 0,
    bottom: 0,
    visibility: isActive ? "visible" : "hidden",
    pointerEvents: isActive ? "auto" : "none",
  }}
>
```

Notes:

- `top: TITLEBAR_HEIGHT` is required because the parent (`App.tsx:487–489`) is `position: relative` with `paddingTop: TITLEBAR_HEIGHT`. Absolutely-positioned children align to the *padding box* of the containing block, which sits *above* the padding — so `top: 0` would overlap the titlebar. The offset and the parent's `paddingTop` must stay in lockstep.
- `data-workspace-active="true"` is set only on the active wrapper (omitted, not `"false"`, when inactive) so selectors of the form `[data-workspace-active] [...]` resolve to the active subtree only.
- No `z-index`: because only one workspace at a time has `visibility: visible`, stacking order is moot.

### `src/lib/dragPaneHitTest.ts`

The previous tab-strip lookup (lines 10–14) relied on the fact that `display: none` ancestors zero out `offsetWidth`/`offsetHeight` to find the *active* workspace's tab strip among multiple opened workspaces' tab strips. With `visibility: hidden`, layout is preserved and the heuristic stops working.

Replaced the `Array.from(querySelectorAll).find(el => el.offsetWidth > 0 ...)` heuristic with a scoped selector:

```ts
const tabStripEl = document.querySelector<HTMLElement>(
  "[data-workspace-active] [data-tab-strip]",
);
```

Comment updated to reflect the new mechanism.

### `docs/adr/0002-layered-workspace-stack-for-snappy-switching.md`

ADR captures the decision, the trade-off (background WebGL paint cost), and the `data-workspace-active` selector contract for future code that needs to distinguish active vs background subtrees.

## Files intentionally not modified

- **`beginWorkspaceSwitch`** (`workspaceStore.ts:450–468`) — the slow path's 2-rAF overlay handshake is correct for cold switches and is not what the user is feeling.
- **`useGitDataSync` `clear()` pattern** (`useGitDataSync.ts:170–171`) — the user's test (collapsing the git panel) showed this is not the dominant cost. Left for the follow-up plan below if needed.
- **`TerminalPool`'s 2-second background-spawn deferral** (`TerminalPool.tsx:29`) — different optimization with a different trade-off; orthogonal to switch latency.
- **`CONTEXT.md`** — "Active workspace" / "Opened workspace" / "Background workspace" still mean exactly what they did before. The change is implementation-level, not domain-level.

## Verification

- `pnpm build` — TypeScript + Vite build green.
- `pnpm test` — 362 / 362 passing (added 4 cache/hydrate tests in `prStore.test.ts`).
- `pnpm check` on touched files — clean (project has unrelated pre-existing lint errors in other files; touched files contribute none).

Manual checks the user should perform in `pnpm tauri dev`:

1. **Snappier switch (primary).** Open 2–3 workspaces. Switch back and forth several times. Click→first visible change gap should be reduced or gone.
2. **Drag-and-drop pane reordering across tabs.** Drag a pane and hover over a tab in the tab strip — the drop indicator should land on the right tab. Verifies the `dragPaneHitTest` selector change.
3. **No focus weirdness.** Click into a terminal, type. Tab into a different workspace's terminal area should not steal focus into a hidden workspace (`pointer-events: none` + `visibility: hidden` should block this; the combination is the safety net).
4. **No double-titlebar.** Confirm the active workspace's tab strip still sits flush under the titlebar, not overlapping it (`top: TITLEBAR_HEIGHT` correctness).
5. **Streaming-agent background workspace.** If you run an agent in workspace A, switch to workspace B, then back to A — confirm scrollback is intact and there's no visible "catch-up" delay.

## Pass 2 — per-workspace cache in `gitChangesStore` and `prStore` (done)

After Pass 1, the user reported click→visible-change time went from ~4s to ~3s — a meaningful but unsatisfying improvement. We then implemented the per-workspace cache that was listed as the top follow-up candidate.

**Premise.** The previous behavior on every workspace switch was `useGitDataSync.ts:170-171` calling `gitChangesStore.clear()` and `prStore.clear()` synchronously. Even with the git panel collapsed, those clears triggered subscriber re-renders for any component reading those singletons (e.g. sidebar git chips). More importantly, on switch back to a workspace you'd just visited, the panel briefly flashed blank → loading → populated, which *perceptually* looks like lag even when the actual milliseconds are modest.

**Approach.** Keep both stores' singleton shape (so no component changes). Add a module-level `Map<workspaceId, ...>` cache. Successful fetches write to the captured workspaceId's cache entry. A new `hydrateFromWorkspace(workspaceId)` method swaps the singleton fields from cache (or empty if no entry yet). `useGitDataSync` calls `hydrate` instead of `clear`, then kicks off the same background refresh as before.

**Subtle correctness point.** `fetchChanges` / `fetchReviewPrs` / `fetchMyPrs` capture `useWorkspaceStore.getState().activeWorkspaceId` at fetch *start*. Cache writes happen against that captured id regardless of whether the user has since switched away (the existing `fetchGeneration` check only guards the singleton update, not the cache write). So if a fetch starts for A, the user switches to B, and A's response then arrives — A's data lands correctly in `cache[A]` and is restored next time the user switches back to A. The singleton stays at B's data because the gen check (and, in practice, the new fetch for B that `useGitDataSync` kicks off) ensures the stale A response can't clobber the singleton.

**Files modified.**

- `src/stores/gitChangesStore.ts` — added `gitChangesCache: Map<workspaceId, GitChangesCacheEntry>` and `fingerprintByWorkspaceId: Map<workspaceId, string>`. `fetchChanges`, `refreshChanges`, and `fetchBranches` now write to the cache. New `hydrateFromWorkspace(workspaceId)` method.
- `src/stores/prStore.ts` — added `prCacheByWorkspaceId: Map<workspaceId, PrCacheEntry>`. `fetchReviewPrs` and `fetchMyPrs` write to the cache. New `hydrateFromWorkspace(workspaceId)` method.
- `src/hooks/useGitDataSync.ts:169-183` — replaced the two `clear()` calls with `hydrateFromWorkspace(activeWorkspaceId)` on both stores. The downstream `fetchChanges` / `checkGhStatus` / `fetchReviewPrs` / `fetchMyPrs` are unchanged.
- `src/stores/__tests__/prStore.test.ts` — four new tests under a `hydrateFromWorkspace` describe block: cache restoration across switches, empty hydrate for never-fetched workspaces, hydrate-with-null clears the singleton, late fetch response still writes to the captured workspaceId's cache.

**Files intentionally not modified.**

- `clear()` on both stores still exists — keeps existing tests working and is available if a non-switch reset is ever needed.
- No `removeWorkspace(workspaceId)` cache cleanup wired up to `deleteWorkspace`. Cache entries for deleted workspaces leak a few KB each until the app restarts. Not worth the circular-import complexity for a rare operation.

## Pass 3 — instrumentation + React 19 `startTransition` (done)

After Pass 2, click→visible-change time was still ~3s — Pass 2 fixed the perceptual "blank flash" but didn't move the actual end-to-end latency. We added measurement to localize the cost, and bundled in the low-risk `startTransition` wrap at the same time.

### Measurement bookends

New helper at `src/lib/switchPerf.ts`. Exposes three functions, all dev-only no-ops in production (`import.meta.env.DEV` guard):

- `markSwitchStart()` — clears prior `switch:*` marks/measures and stamps `switch:click`. Called at the start of the warm-switch fast path in `workspaceStore.ts:beginWorkspaceSwitch`.
- `markSwitch(name)` — stamps `switch:<name>`, but only if `switch:click` already exists (so programmatic / notification-driven `activeWorkspaceId` changes don't produce half-finished logs).
- `reportSwitchPerf()` — computes `performance.measure`s between every adjacent pair of marks that exist (`click→setActive`, `setActive→commit`, `commit→paint`) plus the `total`, and logs them to the console as a single labeled object.

Marks land at four points:

1. **`click`** — at the top of the fast path in `beginWorkspaceSwitch` (`workspaceStore.ts`).
2. **`setActive`** — immediately after `setActiveWorkspace(id)` returns inside the `startTransition` callback. Because Zustand subscribers re-render synchronously, this captures the cost of the subscriber cascade.
3. **`commit`** — in a `useLayoutEffect` in `App.tsx` keyed on `activeWorkspaceId`. Runs after React's commit phase (DOM mutations done) but before the browser paints.
4. **`paint`** — inside a double-`requestAnimationFrame` from that same effect. The double-rAF gives the browser one full paint cycle before stamping, so this approximates "after first paint."

### How to read the segments

| Segment | What dominates it |
|---|---|
| `click → setActive` | The synchronous subscriber-cascade re-render. Big number here = too many or too expensive Zustand subscribers. Fix vectors: split the store into finer slices, narrow selectors, memoize wide subscribers. |
| `setActive → commit` | The gap between handler return and React's commit. Includes any extra React work scheduled in the same event tick (the `mountedTabIds` effect, the `useGitDataSync` effect, etc.) and DOM reconciliation. Big number here = effect cascade or large DOM update. |
| `commit → paint` | Browser-side cost: style/layout/paint. Includes xterm WebGL context activity and the `visibility: hidden → visible` flip's paint. Big number here = browser-layer cost, not a JS problem. |
| `total` | End-to-end click→first paint. |

Whichever segment dominates the 3s tells us which structural fix to attempt next. **Don't pick a fix before reading a real measurement.**

### `startTransition` wrap

Inside `beginWorkspaceSwitch`'s fast path, the `setActiveWorkspace(id)` call is now wrapped in `startTransition` (imported from `react`). This marks any plain React state updates triggered downstream as non-urgent.

**Known limitation — be aware before reading the measurements.** Zustand uses `useSyncExternalStore` for subscriptions, and React explicitly does *not* lower the priority of external-store-driven re-renders inside a transition (to prevent tearing between subscribers). So this wrap does *not* defer the cascade of Zustand subscribers — it only affects components that have their own React `useState` derived from Zustand. In Abundio today, that's a very thin slice. **Expected effect on the `click → setActive` segment: ~zero.** If the segment doesn't move with this in place, the lag is in Zustand-driven subscribers and we need to attack the cascade structurally (next list, item 1).

The reason we added it anyway: the change is one line, low risk, and a negative result is itself diagnostic — it rules out a whole class of React-scheduling fixes.

## Files modified in Pass 3

- `src/lib/switchPerf.ts` *(new)* — the three helpers.
- `src/stores/workspaceStore.ts` — imported `startTransition` and the perf helpers. Fast path of `beginWorkspaceSwitch` now calls `markSwitchStart()`, wraps `setActiveWorkspace(id)` in `startTransition`, and stamps `markSwitch("setActive")` after.
- `src/App.tsx` — added a `useLayoutEffect` keyed on `activeWorkspaceId` that stamps `commit`, double-rAFs to stamp `paint`, then logs. `useLayoutEffect` chosen over `useEffect` because it fires *before* paint, so the `commit` stamp is honest.

## Follow-ups (after reading a measurement)

Once you've switched a few times and seen the per-segment numbers, the dominant segment dictates the next move. Candidates:

**If `click → setActive` dominates** (subscriber cascade is the cost):

1. Split `workspaceStore` so `activeWorkspaceId` lives in a slice that components subscribe to narrowly. Today many components do `useWorkspaceStore((s) => …workspaces…)` and re-render on the `set()` that also updates `activeWorkspaceId`.
2. Audit components for wide selectors (`s.workspaces`, `s.activeWorkspaceId`, etc.) and replace with `useShallow` or per-field selectors.
3. Drop the synchronous `JSON.parse(tab.layoutJson)` for focus restore in `setActiveWorkspace` (`workspaceStore.ts:422`). Either pre-compute `firstLeafId` at layout-write time or defer to a `useEffect`.

**If `setActive → commit` dominates** (effect cascade or DOM cost):

1. Collapse the two `mountedTabIds` effects in `App.tsx:264–292` into one. They fire in sequence on switch and each calls `setState`, costing two React commits.
2. Audit `useGitDataSync`'s effect for any heavy synchronous work (the `hydrateFromWorkspace` calls themselves trigger subscriber re-renders).

**If `commit → paint` dominates** (browser-layer cost):

1. Profile xterm/WebGL activity with the browser's Performance tab. If each xterm WebGL context is forcing a paint on the becoming-visible workspace despite the `visibility: hidden` win in Pass 1, we may need to pause/resume xterm renderers based on `IntersectionObserver` visibility.
2. Check whether `display: none` would be cheaper *in steady state* than `visibility: hidden` if many opened background workspaces accumulate. Pass 1's trade-off may need to be revisited.

**Sanity check before any of the above:** confirm in DevTools that the click event handler itself isn't being delayed by an upstream listener (e.g., a passive scroll handler holding up the event loop). At 3s, a non-React explanation can't be ruled out without measurement.

## Pass 4 — stop disposing WebGL contexts on every switch (done)

### What the Pass 3 measurement said

```
[perf] workspace switch:
  click → setActive:   394ms
  setActive → commit:  111ms
  commit → paint:     3043ms  ← 86% of the cost
  total:              3548ms
```

86% of the lag lives between React's commit and first paint. `startTransition` (also added in Pass 3) had the expected null effect on `click → setActive` — confirming the lag isn't in React scheduling. The cost is on the browser/GPU side.

### Root cause

`src/lib/terminalManager.ts:339-385` subscribes to the workspace store and, on every state change, **disposes the WebGL addon for every terminal not in the currently active tab and creates a fresh WebGL addon for every terminal that is**. The original gate (`activePaneIds`) was added to stay under the browser's ~16 WebGL contexts per page cap. The cost it imposed in the common case wasn't visible until we measured.

Every workspace switch was paying:

1. **Synchronous dispose** of each WebGL addon on the previously-active tab's terminals — included in the `click → setActive` segment.
2. **Synchronous `loadAddon(webgl)`** for each terminal in the new active tab — also in `click → setActive`. This kicks off GPU work (driver setup, shader compilation, texture-atlas creation) but the heavy lifting is queued asynchronously.
3. **Async WebGL initialization + full scrollback redraw** on the render thread for each newly-created context. The browser can't paint the new visible state until this catches up — which is what fills the `commit → paint` window.

With multiple terminals per workspace, this compounded to ~3 seconds.

### Fix

Widened the WebGL gate from "panes in the active tab only" to "panes in any opened workspace." Contexts now stay loaded across workspace and tab switches; the only time `unloadWebgl` runs from the subscriber is for orphan panes still in `instances` but no longer referenced by any opened workspace's layout (rare, happens during tear-down races). Workspace close still tears down the workspace's panes via `destroyTerminal`, which removes them from `instances` entirely.

Inner `isPaneInActiveTab` gate inside `ensureWebglLoaded` deleted — the subscriber is now the authoritative gate, so the inner check was redundant. The function itself was removed (no other callers).

### Trade-off accepted

Users with >16 panes total across all opened workspaces will hit the browser's WebGL context cap. The overflow panes fall back to xterm's DOM renderer via the existing `tryLoadWebgl` catch path. That's a graceful degradation, not a crash. If this becomes a real problem (a user reports a black or rendered-wrong terminal at high pane counts), we add an LRU eviction policy — but the simple-fix-first principle says don't build that until we see the failure.

### Files modified

- `src/lib/terminalManager.ts`
  - `ensureWebglLoaded` no longer gates on `isPaneInActiveTab` — its caller (the store subscription) is the gate.
  - The store subscription now computes `liveWebglPaneIds` as the union of paneIds across every opened workspace's every tab, instead of just the active tab.
  - `isPaneInActiveTab` deleted (unused after the above two changes).

### Expected effect on the measurements

`commit → paint` should drop by an order of magnitude — the WebGL renderer no longer has to rebuild its world on every switch. `click → setActive` should also drop since the synchronous dispose loop is gone. Realistic projection: total drops from ~3500ms toward ~200-400ms. If the measurement after this change isn't dramatically better, our hypothesis about WebGL was wrong and we look elsewhere (likely the xterm DOM-level repaint of newly-visible content, or compositor-layer thrash from the Pass 1 visibility flip).

### Verification

- `pnpm build` green.
- `pnpm test` 362/362 passing.
- No tests existed for the prior WebGL gate behavior (`isPaneInActiveTab` was internal). The behavior change is best validated in `pnpm tauri dev` with the existing Pass 3 measurement bookends.

Manual check: open 2-3 workspaces with terminals in each. Click between them. The `[perf] workspace switch` log should show `commit → paint` in the low hundreds of ms, not thousands.

## Pass 5 — `visibility: hidden` → `opacity: 0` + granular rAF mark (in progress)

### What Pass 4 measurement said

```
[perf] workspace switch:
  click → setActive:    6ms   (was 394ms — confirms WebGL dispose was synchronous)
  setActive → commit:  72ms
  commit → paint:    2937ms   ← essentially unchanged
  total:             3015ms
```

Pass 4 cleanly killed the synchronous WebGL dispose cost (394 → 6ms) but had ~no effect on the 3-second `commit → paint`. So WebGL *recreation* wasn't what filled the paint window — the WebGL contexts are now preserved and the paint window is still 3 seconds. Something else.

### New hypothesis

The visibility transition itself is the cost. WebKit (macOS Tauri's renderer) historically has a slow path for `visibility: hidden ↔ visible` on subtrees containing composited content (WebGL canvases): when an element transitions out of `visibility: hidden`, the compositor invalidates the previously-suppressed paint of the entire subtree and re-rasters. With multiple WebGL canvases per workspace, that re-raster is plausibly 3 seconds.

### Two changes in Pass 5

1. **Swap `visibility` toggle for `opacity` toggle** in `App.tsx`'s workspace wrapper. `opacity: 0` keeps the compositor layer alive and painting continuously — toggling alpha 0 → 1 is a pure compositor operation, typically sub-millisecond, with no re-raster of the subtree.
2. **Add a granular `rAF1` mark** between `commit` and `paint`, so if the opacity swap *doesn't* fully solve it, the next measurement splits the paint window into `commit → rAF1` (frame N's render pipeline) and `rAF1 → paint` (frame N+1's), and we can localize the residual cost.

### Trade-off vs Pass 1's choice

Pass 1 picked `visibility: hidden` over `display: none` to preserve *layout*. We now pick `opacity: 0` over `visibility: hidden` to additionally preserve *paint*. The cost: background workspaces' composited layers keep being included in every compositing pass (just with alpha 0). For modern compositors that's nearly free per-frame, especially compared to alternatives. ADR-0002 should be updated to reflect this if the change holds up.

### Why not just go straight to `transform: translate3d(0,0,0)` / `will-change: transform`?

That would force each workspace wrapper to a dedicated compositor layer (already happens implicitly because of the inner WebGL canvases, but explicit promotion could help). It's worth trying if `opacity: 0` doesn't fully solve it — we can layer it on. For now, change one thing at a time so the measurement attribution stays clean.

### Files modified

- `src/App.tsx` — workspace wrapper style now toggles `opacity: 1|0` + `pointerEvents: auto|none` instead of `visibility: visible|hidden`. Comment in code explains the WebKit-specific motivation.
- `src/lib/switchPerf.ts` — `reportSwitchPerf` now includes `rAF1` in the points list, so the segments report becomes `click→setActive`, `setActive→commit`, `commit→rAF1`, `rAF1→paint`, `total`.
- `src/App.tsx`'s `useLayoutEffect` — the outer `requestAnimationFrame` callback now stamps `rAF1` before scheduling the inner `rAF`. The mark fires inside frame N (just before paint of frame N), so:
  - `commit → rAF1` ≈ scheduling overhead between useLayoutEffect end and frame N's rAF queue (should be near zero in a healthy frame).
  - `rAF1 → paint` ≈ frame N's render pipeline cost (style/layout/paint/composite) + frame N+1's rAF callback fire.
  - If `rAF1 → paint` is the big segment, frame N's paint is the cost — i.e., the visibility/opacity transition.
  - If `commit → rAF1` is the big segment, the main thread is blocked between commit and the next rAF opportunity — implies expensive JS running after commit (e.g., a useEffect doing heavy synchronous work).

### Verification

- `pnpm build` green.
- `pnpm test` 362/362 passing.
- Manual test in `pnpm tauri dev`: click between two warm workspaces, watch the new four-segment log.

### If Pass 5 doesn't solve it

The new breakdown tells us where to look:

- **`rAF1 → paint` dominates** (frame N paint is slow even with opacity): the cost is in the compositor's handling of the WebGL layer arrangement on opacity change. Next step: try `will-change: transform` on the workspace wrapper to force explicit layer promotion, or investigate whether xterm's WebGL addon is doing wasteful work each frame in invisible workspaces (we could pause its rAF loop via `IntersectionObserver`).
- **`commit → rAF1` dominates** (main thread is blocked between commit and next frame): something in the `useEffect` queue is doing heavy synchronous work after commit. Candidates: `useGitDataSync`'s `hydrate` + IPC kickoffs, `App.tsx`'s `mountedTabIds` effect, or another effect we haven't traced.

Either way, the measurement defines the next move.

## Pass 6 — revert opacity, force compositor-layer promotion (in progress)

### What Pass 5 measurement said (two switches)

```
Switch 1:
  click → setActive:    6ms
  setActive → commit:  99ms
  commit → rAF1:     1215ms
  rAF1 → paint:      1635ms
  total:             2955ms

Switch 2:
  click → setActive:    1ms
  setActive → commit:  28ms
  commit → rAF1:     1421ms
  rAF1 → paint:      1270ms
  total:             2720ms
```

Two things to note:

1. **The opacity swap was a wash.** Total is essentially unchanged from Pass 4's 3015ms. So *neither* `visibility: hidden` nor `opacity: 0` is the source of the lag — the compositor pays roughly the same paint cost for either hide technique.
2. **Both rAF segments are big and roughly equal** (~1.2-1.5s each). This is the strong signal. It's not a single 3-second JS block — it's two consecutive ~1.3-second paint cycles. That rules out hypotheses like "an effect after commit doing 3s of synchronous work" and points at per-frame compositor/paint cost.

### Pass 6 changes

1. **Revert `opacity: 0` back to `visibility: hidden`.** Pass 5 was strictly worse in steady state (background WebGL canvases now keep being composited at alpha 0 for no switch-time benefit) and no better at switch time. Going back to `visibility: hidden`.
2. **Add `will-change: transform` + `transform: translateZ(0)` to the workspace wrapper.** Forces the compositor to promote each workspace wrapper to its own composited layer ahead of time. The hypothesis: if the wrapper is already a stable layer, a visibility flip becomes "compositor: show/hide layer" rather than "compositor: invalidate parent, re-rasterize children." With each xterm canvas already being its own layer underneath, the wrapper-level promotion may be what tips the compositor into the fast-path.

### Trade-off

Each promoted layer uses some GPU memory. With 5 opened workspaces, that's 5 extra composited layers (on top of the per-xterm canvas layers that already exist). Modest cost in modern GPUs. If the user's machine starts thrashing GPU memory we revisit.

### Files modified

- `src/App.tsx` — workspace wrapper style: `opacity` toggle removed and replaced with the Pass 1 `visibility` toggle; `willChange: "transform"` and `transform: "translateZ(0)"` added on every opened workspace wrapper (active and inactive). `pointerEvents` toggle preserved.

### If Pass 6 doesn't help

We are at the limit of changes that can be made *without first looking at a DevTools Performance recording*. The next step at that point is:

1. **Record a Performance trace in DevTools.** In `pnpm tauri dev`, right-click → Inspect → Performance tab → Record → click a workspace switch → Stop. The flamegraph in the 3-second window will show exactly what the browser is doing (paint, composite, GPU work, JS) and which DOM/canvas owns the cost. Without this, every further fix is a hypothesis.
2. **Two structural fixes worth considering once a trace localizes the cost:**
   - **Pause xterm WebGL rendering when not visible.** xterm's WebGL addon runs its own `rAF` loop that keeps drawing into the canvas even when the workspace is hidden (we accepted that trade-off in Pass 1 / ADR-0002). If the trace shows xterm-addon-webgl's `render` taking time on every frame for many canvases, pausing background renderers via `IntersectionObserver` would cut steady-state and switch-time cost.
   - **Lazy-mount terminal panes per workspace.** Currently `TerminalPool` mounts terminals for all opened workspaces (after a 2s delay for non-active). If the trace shows the *compositor* setup of many simultaneously-living WebGL canvases is the cost, mounting only the active workspace's panes (unmounting the rest on switch) would help — but it would re-introduce the cold-mount cost we've been trying to avoid. This is the most invasive option, save it for last.

### Verification (current state)

- `pnpm build` green.
- `pnpm test` 362/362 passing.

## Pass 7 — defer git/gh fetches to after first paint (in progress)

### What the Pass 6 measurements said (with the scale test)

Critical scale-test result from the user:

```
2 workspaces × 1 terminal each, NOT a git repo:
  total: 214ms        ← this is the actual baseline cost
3 terminals + git repo:
  total: 2038ms
1 terminal + git repo:
  ~2000ms (user reported)
```

The lag does **not** scale with terminal count. It scales with **git-repo-ness**. A non-git workspace switches in ~200ms — that's the real paint+compositor baseline. Every git workspace pays an additional ~1.8 seconds, regardless of how many terminals it has.

That kills the WebGL-canvas-compositor hypothesis. The cost is in the git/gh code path.

### Root cause

`useGitDataSync.ts` was kicking off `fetchChanges`, `checkGhStatus`, `fetchReviewPrs`, and `fetchMyPrs` inline inside the workspace-switch `useEffect`. Each of those store methods calls `set({ loading: true, ... })` *synchronously* before awaiting its IPC. Every such `set` triggers a synchronous re-render cascade through every subscriber to the affected store:

- `gitChangesStore.fetchChanges` → re-renders `GitChangesPanel`, sidebar git chips, anything reading `useWorkspaceGitStore` (via the `setInfo` side-channel), etc.
- `prStore.fetchReviewPrs` → re-renders `PullRequestsSection`, the `usePrStore.subscribe` notification observer at `prStore.ts:175-273` (which itself walks the prev/state diff).
- `prStore.fetchMyPrs` → same.

Three synchronous `set()`s, three cascades, all running inside the `useEffect` *before* it returns. The `useEffect` doesn't yield until those cascades complete, so `useLayoutEffect`-based rAF doesn't fire until ~2 seconds later. That's the `commit → rAF1 = 1025ms` + `rAF1 → paint = 1363ms` we kept measuring.

For non-git workspaces, the IPC catch path runs and the synchronous loading-state `set`s effectively no-op against subscribers that bail on `!isGitRepo` early — so the cascade is cheap and the switch lands at ~200ms.

### Fix

Wrap the IPC kickoffs in `requestAnimationFrame` inside `useGitDataSync`'s `useEffect`. The visible workspace switch paints first (at ~200ms — the non-git baseline); the fetch kickoffs and their synchronous loading-state `set`s fire one frame later. The user perceives an instant switch, with the panel briefly showing cached data (from the still-synchronous `hydrateFromWorkspace` calls) and then updating as IPC responses arrive over the next ~1-2 seconds.

Critically, `hydrateFromWorkspace` stays synchronous so the panel never visibly "blinks" the previous workspace's data — destination workspace's cached data shows immediately.

### Files modified

- `src/hooks/useGitDataSync.ts` — IPC kickoffs (`fetchChanges`, `checkGhStatus → fetchReviewPrs/fetchMyPrs`) moved inside a `requestAnimationFrame`. Cleanup via `cancelAnimationFrame` + a `cancelled` flag in case the user switches away before the rAF fires.

### Expected effect on the measurements

`commit → rAF1` should drop dramatically (from ~1000ms toward ~30ms). `rAF1 → paint` should also drop (~1300ms toward ~50ms). Total: **target ~200-300ms** — i.e., approximately matching the non-git baseline. If the measurements land there, the lag is solved; the panel updates async over the next ~1-2 seconds without blocking interaction.

### What still might be true after Pass 7

- The `useGitDataSync` background fetches still take 1-2 seconds — that's the underlying git/gh subprocess + GitHub API roundtrip cost. We're not making those *faster*, we're making them *not block the visible switch*. If individual fetches are still bottlenecks for the panel data appearing, the next pass would look at: (a) skipping fetches when cached data is fresh (e.g., < 30 seconds old), (b) parallelizing fetchReviewPrs and fetchMyPrs (already sequential per the existing code), (c) caching `gh status` per-cwd across switches.
- Pass 6's `will-change: transform` + `translateZ(0)` are still in place. If Pass 7 lands the total at ~200ms and we want to confirm whether Pass 6's promotion is doing anything, a cleanup pass would compare with and without and revert the layer promotion if it's noise.

### Verification

- `pnpm build` green.
- `pnpm test` 362/362 passing.

## Pass 8 — freshness gate on the on-switch background fetch (in progress)

### What Pass 7 measurement + perception said

```
click → setActive:    5ms
setActive → commit:  97ms
commit → rAF1:      311ms  ← dropped from 1025ms (Pass 6)
rAF1 → paint:      2241ms  ← went UP from 1363ms (Pass 6)
total:             2654ms  ← essentially unchanged
```

Two important signals:
1. **The defer worked at its declared job** — frame N's blocking JS dropped from 1025ms to 311ms. The visible workspace switch lands ~700ms sooner in the measurement.
2. **The user reports it doesn't *feel* faster.** That means "feel" isn't gated by frame N's paint timing — it's gated by **main-thread busy-ness**. While IPC responses arrive over 1-2 seconds, each fires synchronous Zustand `set`s that re-render subscribers; that JS work makes the UI unresponsive to input even after the new workspace is on screen.

So moving the work *when it runs* didn't help; we need to **not do the work at all** when it's wasted.

### Root realization

Most rapid switches are between recently-visited workspaces. If you switched away from workspace A 5 seconds ago, A's git+gh data hasn't meaningfully changed (file watchers via `useFileReloadWatcher` keep it up to date, and the 60s gh polling interval keeps PR data current). Re-running the full IPC sweep on switch was paying for refreshes the cache already had.

### Fix

Added a module-level `Map<workspaceId, lastFetchedAtMs>` in `useGitDataSync.ts`. On workspace switch, after `hydrate` runs (synchronous, restores cached data instantly), check the last-fetched timestamp for the destination workspace. If it's been less than `SWITCH_REFRESH_FRESHNESS_MS` (30 seconds) since the last on-switch fetch, **skip the IPC kickoff entirely**. The cache is fresh; file watchers + polling will keep it that way.

Pass 7's `requestAnimationFrame` defer stays in place as a belt-and-suspenders measure for the case where the freshness gate misses (first visit per workspace per 30s, or after a fresh app launch).

### What the user should see now

- **Rapid back-and-forth between recently-visited workspaces**: instant. No IPC, no synchronous `set` cascades. Total switch cost should match the non-git baseline (~200ms).
- **First visit to a workspace this session, or after a 30s gap**: still ~2 seconds. The full IPC sweep has to run at least once to populate the cache. We're not making the first visit faster; we're making *repeat visits* not pay for it again.
- **After 30 seconds on the same workspace, switching away and back**: full fetch fires. Same lag as before for that one switch.

### Trade-off

Data shown immediately after a switch may be up to 30 seconds stale. In practice, file watchers usually keep changed-file data current within ~500ms, and PR data only changes on the order of minutes anyway. If staleness becomes a real problem (e.g., "I made a commit and the chip didn't update on switch"), we shorten the window or add an event-based invalidation.

### Files modified

- `src/hooks/useGitDataSync.ts`
  - Added `SWITCH_REFRESH_FRESHNESS_MS = 30_000` constant and `lastSyncByWorkspaceId: Map<string, number>` at module scope.
  - On-switch `useEffect`: hydrate stays synchronous (instant cached-data restore). Background fetch kickoff is now gated on `Date.now() - lastSyncByWorkspaceId.get(wsId) >= SWITCH_REFRESH_FRESHNESS_MS`. When the gate is open, the timestamp is updated and Pass 7's rAF-deferred kickoff chain runs.

### What this *doesn't* fix

The **first switch** to a workspace this session still takes ~2 seconds — the IPC sweep has to run at least once to populate the cache. Making the first visit faster requires either pre-fetching (e.g., on app startup, kick off all opened workspaces' fetches in parallel) or running IPCs off the main thread (web workers — significant complexity).

If first-visit latency becomes the primary complaint after Pass 8 lands, the next pass would be **eager prefetch on app startup**: for every workspace in `openedWorkspaceIds` at boot, fire the git+gh fetches in parallel before the user touches anything. By the time they click a workspace, the cache is warm and the freshness gate kicks in.

### Verification

- `pnpm build` green.
- `pnpm test` 362/362 passing.
- Manual: open a git repo workspace, wait for the panel to fully load (~2s on first visit), switch to another opened workspace, switch back. The second switch should be near-instant in the `[perf]` log (~200ms, matching the non-git baseline).

## Pass 9 — cleanup of vestigial passes (done)

Once Pass 8's freshness gate landed and confirmed the win, three earlier changes were either inert or marginal-with-cost. Removed:

- **Pass 3's `startTransition` wrap** in `workspaceStore.ts` (`beginWorkspaceSwitch` fast path). Confirmed null effect — Zustand subscribers via `useSyncExternalStore` re-render synchronously regardless of transition priority. The `react` import was dropped and the wrap collapsed to a direct call to `setActiveWorkspace(id)`. The `markSwitchStart()` and `markSwitch("setActive")` calls remain (perf marks are still useful for future investigations).
- **Pass 6's `will-change: transform` + `transform: translateZ(0)`** on the workspace wrapper in `App.tsx`. The ~250ms improvement claimed by the measurement was within the natural variance of repeated switches in Pass 5 (235ms). Removed to avoid paying the modest per-workspace GPU memory cost for unproven benefit.

Kept:

- **Pass 7's `requestAnimationFrame` defer + cancellation** in `useGitDataSync.ts`. Even though Pass 7 alone didn't perceptually help, it's the path that runs when Pass 8's freshness gate misses (first visit of the session, or after a 30s gap). In those cases, frame N's blocking JS still drops 700ms in the measurement; that's a real if modest improvement for the unavoidable "first fetch" case.

## Pass 10 — remove the perf instrumentation (done)

With the investigation complete, the dev-only perf marks (`src/lib/switchPerf.ts`, the `markSwitch`/`markSwitchStart` calls in `workspaceStore.ts`, and the `useLayoutEffect` measurement block in `App.tsx`) were logging `[perf] workspace switch: {...}` to the console on every switch. That console noise is no longer wanted. Since the `console.log` in `reportSwitchPerf` was the only consumer of the marks, the entire instrumentation was removed rather than left as dead code:

- `src/lib/switchPerf.ts` deleted.
- `workspaceStore.ts` — `markSwitch`/`markSwitchStart` import and calls removed from `beginWorkspaceSwitch`.
- `App.tsx` — `switchPerf` import, the perf `useLayoutEffect`, and the now-unused `useLayoutEffect` React import all removed.

If a future perf investigation needs this, the pattern is recorded in this document's Pass 3 section and can be reconstructed.

## Final landed state

The fixes that actually moved the needle:

| Pass | Change | Status |
|---|---|---|
| 1 | Absolute-stacked workspaces + `visibility: hidden` (ADR-0002) | Kept |
| 2 | Per-workspace cache in `gitChangesStore` / `prStore` with `hydrateFromWorkspace` | Kept |
| 4 | WebGL contexts preserved across switches (`terminalManager.ts`) | Kept |
| 7 | rAF defer of git/gh kickoffs | Kept (belt-and-suspenders for cache-miss case) |
| 8 | 30s freshness gate on on-switch git/gh fetches | Kept — the actual fix |

Passes 5 and 6 reverted; Pass 9 cleaned up 3's `startTransition` and 6; Pass 10 removed the Pass 3 perf instrumentation entirely.

If first-visit latency ever becomes the primary complaint, the natural next step is **eager prefetch on app startup** — fire all opened workspaces' git+gh fetches in parallel at boot so Pass 8's freshness gate kicks in for every switch from then on. Until that's a real complaint, leave it alone.

## Notes on the constraint that drove this design

The CSS technique works *because* opened workspaces already render eagerly into the DOM (one of them at a time was just toggled visible). If a future change ever switches Abundio to lazily-mount opened workspaces, this whole plan becomes moot — and the trade-off in ADR-0002 reverses (the cheap thing then is to keep `display: none` because the layout cost is paid on first mount, not on every switch). Flag for any future refactor that touches the workspaces map.
