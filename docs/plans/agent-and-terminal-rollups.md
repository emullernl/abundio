# Agent and Terminal rollups

Decision record: ADR-0032. Glossary: **Agent rollup**, **Terminal rollup**, **Hidden rollup** in `CONTEXT.md`.

## Goal

Replace the one mixed status icon on Tabs and sidebar Workspace rows with two: an Agent rollup (agent-mode PTYs) and a Terminal rollup (shell-mode PTYs). Hovering either gives its count breakdown.

## Steps (one branch, `feat/agent-terminal-rollups`)

1. **Pure model** in `stores/ptyActivityStore.ts`: `computeWorkspaceRollups`, `computeTabRollups`, `mergeRollups`, `mostUrgentStatus`, `rollupTooltip`. Retires `computeWorkspaceDotStatus` / `computeTabDotStatus` and the ADR-0009 `rollsUp` filter. Table tests.
2. **Hooks** in `hooks/useWorkspaceRollups.ts` (renamed from `useWorkspaceDotStatus.ts`): subscribe via a serialized key so a tick re-renders only when a count changes. The Hidden rollup sums members and keeps the per-member tooltip on its count.
3. **UI**: `RollupIcon` (icon + tooltip, nothing when absent).
   - `WorkspaceItem`: left slot stacks Agent (name line) over Terminal (path line); the fold chevron swaps with the top cell only. Hidden rollup stacks the same way at the right end.
   - `CollapsedStrip`: same stack at 12px; one badge at the more urgent status.
   - `TabBar`: side by side before the name, Agent first.
4. **Verify** in `pnpm demo:web`: alignment, folded set, collapsed strip, tooltips.
