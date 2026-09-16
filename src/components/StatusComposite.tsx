import { memo } from "react";
import {
	BADGE_FORM,
	BADGE_OVERHANG,
	BADGE_SIZE,
	compositeParts,
	compositeTooltip,
	PRIMARY_SIZE,
} from "../lib/statusComposite";
import {
	type DotStatus,
	dotStatusLabel,
	type Rollups,
	type WorkspaceRollups,
} from "../stores/ptyActivityStore";
import {
	AgentStatusIcon,
	DOT_STATUS_ANIMATED,
	DOT_STATUS_COLOR,
} from "./AgentStatusIcon";

interface StatusCompositeProps {
	rollups: Rollups | WorkspaceRollups;
	/** Override the primary's size; the badge scales with it. The narrow strip
	 *  and the Tab bar use the shared default — see ADR-0033 on why they must
	 *  not disagree. */
	size?: number;
	/** Swapped in on hover of the enclosing `.group`, covering the **whole**
	 *  composite — primary and badge alike. A Worktree set's Primary row puts
	 *  its fold chevron here. ADR-0033 accepts that this hides the badge too:
	 *  ADR-0032's "never fully covered" promise assumed two separate icons. */
	overlay?: React.ReactNode;
}

/** The **Status badge**: the Terminal rollup, small, on the primary's
 *  lower-right. A glyph by default; `BADGE_FORM` swaps every badge to a plain
 *  dot in one place if 8px proves too small for the chevron. */
const Badge = memo(function Badge({
	status,
	size,
}: {
	status: DotStatus;
	size: number;
}) {
	if (BADGE_FORM === "glyph") {
		return <AgentStatusIcon status={status} size={size} />;
	}
	return (
		<span
			aria-hidden
			style={{
				display: "block",
				width: size,
				height: size,
				borderRadius: "50%",
				backgroundColor: DOT_STATUS_COLOR[status],
				// Ring in the row's own background so the dot reads as separate
				// from the glyph it sits beside.
				boxShadow: "0 0 0 1.5px var(--bg-secondary)",
				// A dot can't carry the glyph's motion at this size, but it must
				// not sit still while the pane's icon moves.
				animation: DOT_STATUS_ANIMATED[status]
					? "shell-running-breathe 1.6s ease-in-out infinite"
					: undefined,
			}}
		/>
	);
});

/**
 * One **Status composite** — a Tab's or Workspace's whole status as a single
 * mark: a **Primary icon** with an optional **Status badge** on its lower-right
 * corner (ADR-0033, replacing ADR-0032's two icons of equal weight).
 *
 * Renders nothing when there are no PTYs of either kind — "absent, not Idle" is
 * unchanged from ADR-0032. A Workspace never opened in this Window draws the
 * grey "Not opened" icon in the primary's place.
 */
export const StatusComposite = memo(function StatusComposite({
	rollups,
	size = PRIMARY_SIZE,
	overlay,
}: StatusCompositeProps) {
	const notOpened = "notOpened" in rollups && rollups.notOpened;
	const { primary, badge } = compositeParts(rollups);
	const badgeSize = Math.round((BADGE_SIZE / PRIMARY_SIZE) * size);
	const overhang = Math.round((BADGE_OVERHANG / PRIMARY_SIZE) * size);

	if (!notOpened && !primary && !overlay) return null;

	return (
		<span
			className="relative flex flex-shrink-0"
			// The box reserves the badge's overhang, so no call site has to
			// remember to — a badge can never collide with the text beside it.
			// The primary glyph sits at the left of that box; the trailing strip
			// is the badge's room.
			style={{ width: compositeWidth(size), height: size }}
			data-status-composite={
				notOpened ? "grey" : (primary?.rollup.status ?? "none")
			}
			title={notOpened ? dotStatusLabel("grey") : compositeTooltip(rollups)}
		>
			<span
				className={
					overlay
						? "absolute transition-opacity duration-150 group-hover:opacity-0"
						: "contents"
				}
				style={
					overlay ? { left: 0, top: 0, width: size, height: size } : undefined
				}
			>
				{notOpened ? (
					<AgentStatusIcon status="grey" size={size} />
				) : (
					primary && (
						<AgentStatusIcon status={primary.rollup.status} size={size} />
					)
				)}
				{badge && (
					<span
						className="absolute flex"
						data-status-badge={badge.status}
						// Centred on the primary's lower-right corner: the glyph
						// occupies [0, size] and the box is `size + overhang` wide,
						// so the badge straddles x = size and the rest of the
						// overhang is the clear space the reservation buys.
						style={{
							left: size - Math.round(badgeSize / 2),
							bottom: -Math.round(overhang / 2),
						}}
					>
						<Badge status={badge.status} size={badgeSize} />
					</span>
				)}
			</span>
			{overlay && (
				// Covers the primary's square only, not the badge's reserved
				// strip — so a swapped-in chevron stays centred on the glyph it
				// replaces rather than drifting right.
				<span
					className="absolute flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
					style={{ left: 0, top: 0, width: size, height: size }}
				>
					{overlay}
				</span>
			)}
		</span>
	);
});

/** The width a composite occupies, including its badge's overhang, at a given
 *  primary size. `StatusComposite` reserves this itself; exported for the rare
 *  call site that needs to reason about the width without rendering one. */
export function compositeWidth(size: number = PRIMARY_SIZE): number {
	return size + Math.round((BADGE_OVERHANG / PRIMARY_SIZE) * size);
}
