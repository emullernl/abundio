# Collapsed sidebar shows a per-workspace strip with a hover popover

## Context

Today the collapsed sidebar (`Sidebar.tsx:210–243`) is a 56px column containing only a chevron toggle and a search button. Workspaces are completely invisible when collapsed, so users can't see status (working / waiting / error) or switch workspaces without first expanding the sidebar.

User wants the collapsed sidebar to:

1. Show every workspace as a compact strip — status icon + the workspace name fading to transparent at the right edge.
2. On hover, reveal the full `WorkspaceItem` (name, branch chip, path, change counts, delete-on-hover, rename context menu) as it appears in the expanded sidebar.
3. Click the strip to switch workspace; right-click for the same context menu as expanded.

## Decisions

- **Letter rendering**: full `workspace.name` with `mask-image: linear-gradient(to right, black 50%, transparent)` so the trailing chars fade out. No truncation rules; works at any background colour because the mask is alpha-based, not painted-over.
- **Hover popover**: portal'd flyout anchored at `left: 56px, top: itemRect.top`, width = saved `sidebarWidth` from settings, renders the existing `<WorkspaceItem>` at full fidelity. Stays open while the cursor is over the strip OR the popover, with a ~100ms open/close delay to prevent flicker across the 0px gap.
- **Click semantics**: strip is fully clickable — same `beginWorkspaceSwitch` / context-menu / focus behaviour as the expanded item. Popover is purely informational + a host for the hover-X delete button and rename input.
- **No drag-to-reorder in collapsed**: dragging from a 56px strip with a ghost rendered at expanded width is awkward; users reorder by expanding first. The 5px drag threshold also made accidental switches likely.
- **Row height = 50px**: matches the expanded item height so an item at viewport Y=300 stays at Y=300 across a collapse/expand toggle. The cursor stays parked on the same workspace.
- **No ADR / no CONTEXT.md update**: the change is reversible CSS + component-structure choices; the collapsed mode is a UI affordance, not domain language.

## Approach

Thread the popover through `WorkspaceList` rather than `Sidebar`, so the rename/delete state machine stays in one place. The popover's "X" click reaches `setPendingDeleteId` directly; the context menu's "Rename" reaches `setRenamingId` directly. Both variants of the list (expanded, collapsed) share one state owner.

`WorkspaceList` grows a `variant: "expanded" | "collapsed"` prop. In `"collapsed"` mode it:

- Skips drag setup entirely — no `handleMouseDown` mousedown-threshold logic, no `DragGhost`, no `DropIndicator`.
- Renders each workspace via a new `CollapsedStrip` component instead of `WorkspaceItem`.
- Keeps the rename, delete-confirm, and context-menu plumbing untouched — `CollapsedStrip` receives the same `onClick / onContextMenu / onRename / onDelete / isActive / isRenaming` props as `WorkspaceItem` and forwards them to the popover's inner `<WorkspaceItem>`.

`Sidebar.tsx`'s `if (sidebarCollapsed)` branch keeps the chevron + search buttons at the top and renders `<WorkspaceList variant="collapsed" />` below them.

## Files to modify / create

### New: `src/components/Sidebar/CollapsedStrip.tsx`

A 56×50 strip rendering:

- Left: `<AgentStatusIcon status={dotStatus} />` using the same `useWorkspaceDotStatus` hook that `WorkspaceItem` uses (refactor that hook into a shared module or duplicate the body — small enough either way).
- Right: `<span>` with `workspace.name`, styled with `mask-image: linear-gradient(to right, black 50%, transparent)` and `overflow: hidden; white-space: nowrap`.
- Active-state border + tinted background identical to `WorkspaceItem` (lines 113–117 of WorkspaceItem.tsx).
- `onClick` → calls the passed-in `onClick` (which the list wires to `beginWorkspaceSwitch`).
- `onContextMenu` → calls the passed-in `onContextMenu`.
- `onMouseEnter` / `onMouseLeave` with a `setTimeout`-based 100ms close delay → toggles `popoverOpen` state.

The popover itself:

- Rendered via `createPortal` to `document.body` to escape the narrow column.
- Positioned via `useLayoutEffect` measuring the strip's `getBoundingClientRect()`: `position: fixed; left: 56; top: rect.top; width: sidebarWidth`.
- Listens to its own `onMouseEnter` / `onMouseLeave` and shares the 100ms close-delay state with the strip so moving between them keeps it open.
- Renders `<WorkspaceItem>` with the exact same prop set the expanded list passes, so the hover-X delete and rename-on-context-menu work without any new wiring.

### Modify: `src/components/Sidebar/WorkspaceList.tsx`

- Add `variant?: "expanded" | "collapsed"` (default `"expanded"`).
- Branch the render loop: when `variant === "collapsed"`, map workspaces to `<CollapsedStrip>` instead of `<WorkspaceItem>`, and skip rendering `DragGhost` / `DropIndicator`.
- Skip the drag mousemove `useEffect` when collapsed (gate on variant at the top of the effect, return early).
- The `ConfirmDialog` and `PaneContextMenu` portals stay; both variants funnel into the same state.

### Modify: `src/components/Sidebar/Sidebar.tsx`

- In the `if (sidebarCollapsed)` branch (line 210), keep the chevron + search buttons unchanged and add `<WorkspaceList variant="collapsed" />` underneath.
- Wrap the workspace strip area in a `flex-1 overflow-y-auto` container so long workspace lists scroll inside the collapsed bar.

### Optional refactor: `src/components/Sidebar/WorkspaceItem.tsx`

`useWorkspaceDotStatus` is currently file-local in `WorkspaceItem.tsx` (lines 38–60). `CollapsedStrip` needs the same hook. Either export it from `WorkspaceItem.tsx` or extract it to `src/hooks/useWorkspaceDotStatus.ts`. The extraction is preferable (no cross-component import via a sibling), but it's not load-bearing — duplicating the 22 lines is acceptable if extraction conflicts with anything.

## Out of scope

- Drag-to-reorder from the collapsed strip.
- Showing the file-explorer toggle in the collapsed bar (currently only the search button is there).
- Animating the hover popover (instant show/hide with the 100ms delay is fine for v1).
- Tooltip-mode fallback (e.g. for reduced-motion / coarse-pointer environments) — covered by the popover already.
