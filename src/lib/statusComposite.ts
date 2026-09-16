import type {
	KindRollup,
	RollupKind,
	Rollups,
} from "../stores/ptyActivityStore";
import { rollupTooltip } from "../stores/ptyActivityStore";

// ── Geometry ──
// One set of sizes for every **Status composite**, read by both sidebar widths
// and the Tab bar. The expanded row and the narrow strip used to disagree
// (14px/4px gap against 12px/3px), so the icons visibly jumped when the sidebar
// was collapsed or expanded — and hovering a strip pops the expanded row out on
// top of it, which animated the mismatch on every hover. See ADR-0033.

/** The **Primary icon**. Deliberately not larger than the two equal icons it
 *  replaces: it already reads as twice the weight by being one mark instead of
 *  one of two, and any increase is paid for out of the 56px narrow strip's
 *  text, the most starved space in the app. */
export const PRIMARY_SIZE = 14;

/** The **Status badge**. */
export const BADGE_SIZE = 8;

/** How far the badge hangs past the primary's box, bottom and right. Every
 *  status glyph is a stroked outline, and two overlapping outlines read as
 *  neither — so most of the badge sits outside. Offsetting also avoids a
 *  background plate, which would have to track the row's hover and active
 *  tints. */
export const BADGE_OVERHANG = 5;

/** Width the composite occupies, including the badge's overhang, so a badge
 *  can never collide with the name beside it. */
export const COMPOSITE_WIDTH = PRIMARY_SIZE + BADGE_OVERHANG;

/** Whether the badge draws the rollup's own glyph or a plain filled dot.
 *  At 8px a three-stroke breathing chevron may read as mush; if it does, this
 *  one constant swaps every badge in the app without touching a call site.
 *  See ADR-0033. */
export const BADGE_FORM: "glyph" | "dot" = "glyph";

// ── What the composite draws ──

export interface CompositeParts {
	/** The larger leading icon, with the kind it came from. `null` only when
	 *  there are no PTYs of either kind — nothing is drawn at all. */
	primary: { kind: RollupKind; rollup: KindRollup } | null;
	/** The small corner icon, always the **Terminal rollup**. `null` whenever
	 *  the terminal rollup is absent, Idle, or already the primary. */
	badge: KindRollup | null;
}

/** Is this Terminal rollup worth a badge? Only Error and Working — a terminal's
 *  Idle never earns one, because the badge exists to surface what wants
 *  attention and idle shells are the normal case. The suppression belongs to
 *  the badge, not to the rollup: when the Terminal rollup *is* the primary it
 *  shows Idle as usual. See ADR-0033. */
function badgeWorthy(terminal: KindRollup | null): boolean {
	if (!terminal) return false;
	return terminal.counts.error > 0 || terminal.counts.working > 0;
}

/**
 * Split a Tab's or Workspace's rollups into a **Primary icon** and an optional
 * **Status badge**.
 *
 * The primary is the **Agent rollup** whenever any agent-mode PTY exists,
 * otherwise the **Terminal rollup**. It is never displaced: a shell Error next
 * to an idle Agent is a red badge on a calm green circle, not a red primary, so
 * the big icon always answers the same question and never changes what it is
 * describing under the reader. See ADR-0033.
 */
export function compositeParts(rollups: Rollups): CompositeParts {
	if (rollups.agent) {
		return {
			primary: { kind: "agent", rollup: rollups.agent },
			badge: badgeWorthy(rollups.terminal) ? rollups.terminal : null,
		};
	}
	if (rollups.terminal) {
		// The Terminal rollup is the primary, so there is nothing left to badge.
		return {
			primary: { kind: "terminal", rollup: rollups.terminal },
			badge: null,
		};
	}
	return { primary: null, badge: null };
}

/**
 * Hover text for the whole composite: one line per present rollup, most urgent
 * first, zero counts omitted.
 *
 * One tooltip rather than two, because an 8px badge is a miserable hover
 * target. It is also the only place a Terminal rollup's **Idle** count is
 * always visible, which is what keeps "my terminals are fine" and "I have no
 * terminals" tellable apart when the badge draws nothing. See ADR-0033.
 */
export function compositeTooltip(rollups: Rollups): string {
	const lines: string[] = [];
	if (rollups.agent) lines.push(rollupTooltip("agent", rollups.agent.counts));
	if (rollups.terminal) {
		lines.push(rollupTooltip("terminal", rollups.terminal.counts));
	}
	return lines.join("\n");
}
