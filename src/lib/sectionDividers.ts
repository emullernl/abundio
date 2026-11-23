/**
 * Where the Workspace list draws a divider between its sections (this
 * Window's own, then each Joined profile's): before a section that shows
 * something, when a section above it showed something too. Never at the top
 * or bottom, never two in a row. Pure.
 */
export function dividersBefore(shows: readonly boolean[]): boolean[] {
	let seen = false;
	return shows.map((s) => {
		const divider = s && seen;
		if (s) seen = true;
		return divider;
	});
}
