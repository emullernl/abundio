/** The **Dirty marker**: a small hollow ring in the warning colour, drawn only
 *  for a **Dirty workspace**.
 *
 *  Hollow on purpose. In the sidebar a *filled* circle is always a status badge
 *  (amber meaning Working), so the shape — not only the colour — keeps git
 *  state apart from PTY status. See CONTEXT.md. */
export function DirtyMarker({
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
