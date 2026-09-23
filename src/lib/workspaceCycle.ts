/**
 * The **Workspace cycle** target: the next (`step` 1) or previous (`step` -1)
 * **Opened workspace** after `activeId` in `orderIds` (Left sidebar order),
 * wrapping at the ends. Workspaces that are not Opened are skipped, so the
 * cycle never opens one — and never spawns a PTY as a side effect.
 *
 * The Active workspace counts as Opened even if the set has not caught up yet.
 * Returns `null` when there is no other Opened workspace to go to.
 */
export function cycleOpenedWorkspace(
	orderIds: readonly string[],
	opened: ReadonlySet<string>,
	activeId: string | null,
	step: 1 | -1,
): string | null {
	const ring = orderIds.filter((id) => opened.has(id) || id === activeId);
	if (ring.length === 0) return null;
	const idx = activeId ? ring.indexOf(activeId) : -1;
	if (idx === -1) return step === 1 ? ring[0] : ring[ring.length - 1];
	if (ring.length === 1) return null;
	return ring[(idx + step + ring.length) % ring.length];
}
