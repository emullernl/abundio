/** The **Dirty marker** for a row's *own* Workspace: a warning-coloured bar
 *  down the row's right edge, drawn only for a **Dirty workspace**.
 *
 *  The right edge because the left one is the Active workspace's accent, and a
 *  background tint is out: the row background already carries active and hover,
 *  and on a real workspace list most rows are dirty at any moment — a colour
 *  that covers most of the list stops meaning "look here". See CONTEXT.md. */
export function DirtyEdge({ title }: { title: string }) {
	return (
		<span
			data-dirty-marker
			role="img"
			aria-label={title}
			title={title}
			style={{
				position: "absolute",
				top: 2,
				bottom: 2,
				right: 0,
				width: 3,
				borderRadius: 2,
				backgroundColor: "var(--warning)",
			}}
		/>
	);
}

/** The Dirty marker where a row-edge bar cannot go: a small hollow ring for
 *  members a **Folded set** is hiding, whose rows are not rendered at all.
 *
 *  Hollow on purpose. In the sidebar a *filled* circle is always a status badge
 *  (amber meaning Working), so the shape — not only the colour — keeps git
 *  state apart from PTY status. */
export function DirtyRing({
	title,
	size = 6,
	/** Paint the centre and a halo in this colour, for placements that sit on
	 *  top of another glyph — so the ring reads as hollow rather than as a
	 *  circle drawn over whatever is underneath. */
	cutout,
	style,
}: {
	title: string;
	size?: number;
	cutout?: string;
	style?: React.CSSProperties;
}) {
	return (
		<span
			data-dirty-marker
			role="img"
			aria-label={title}
			title={title}
			style={{
				display: "inline-block",
				flexShrink: 0,
				boxSizing: "border-box",
				width: size,
				height: size,
				borderRadius: "50%",
				border: "1.5px solid var(--warning)",
				backgroundColor: cutout ?? "transparent",
				boxShadow: cutout ? `0 0 0 1.5px ${cutout}` : undefined,
				...style,
			}}
		/>
	);
}
