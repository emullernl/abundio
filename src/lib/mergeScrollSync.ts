/**
 * Scroll synchronisation across a Merge view's editors.
 *
 * Not a shared `scrollTop`: the result document contains *both* sides plus the
 * marker lines, so equal offsets fall out of step after the very first conflict
 * and get worse with each one. Instead each side keeps a list of **anchors** —
 * line pairs where it is known to line up with the result — and scrolling maps
 * through them by piecewise-linear interpolation. Between anchors the documents
 * really are the same text, so the interpolation is exact there and only
 * approximates *inside* a conflict region, which is the one place the two
 * genuinely differ.
 *
 * The result pane is the hub: a side scroll maps to a result position first,
 * then out to the other sides. That keeps N panes consistent without N² maps.
 *
 * Offsets are read through Monaco's own `getTopForLineNumber` rather than a
 * uniform line height, so the mapping holds with word wrap enabled — where a
 * single line can occupy several visual rows.
 */
import type { editor } from "monaco-editor";
import type { ConflictBlock, SideRange } from "./conflictMarkers";

/** A line in the result document and the line it corresponds to in a side. */
export interface LineAnchor {
	result: number;
	side: number;
}

/**
 * Anchors between the result document and one side's stage document.
 *
 * Both ends of every located conflict region are anchored, plus the start and
 * end of the documents, so the common text between regions maps one-to-one.
 */
export function buildSideAnchors(
	blocks: ConflictBlock[],
	ranges: (SideRange | null)[],
	resultLineCount: number,
	sideLineCount: number,
): LineAnchor[] {
	const raw: LineAnchor[] = [{ result: 1, side: 1 }];

	// Anchor the *whole* conflict block in the result — opener through closer —
	// against the side's region. Anchoring the side's own sub-range instead
	// would spread the marker lines' offset back across the shared text before
	// the block, so the common preamble would drift by a fraction of a line
	// rather than matching exactly. Only the interior of a region is
	// approximated, which is the one place the documents really differ.
	blocks.forEach((block, i) => {
		const range = ranges[i];
		if (!range) return;
		raw.push({ result: block.startLine, side: range.startLine });
		raw.push({ result: block.endLine + 1, side: range.endLine + 1 });
	});

	raw.push({ result: resultLineCount + 1, side: sideLineCount + 1 });

	// Strictly increasing on both axes, or interpolation divides by zero and a
	// region whose side is empty would map backwards.
	raw.sort((a, b) => a.result - b.result || a.side - b.side);
	const out: LineAnchor[] = [];
	for (const anchor of raw) {
		const last = out[out.length - 1];
		if (!last) {
			out.push(anchor);
			continue;
		}
		if (anchor.result > last.result && anchor.side > last.side)
			out.push(anchor);
	}
	return out;
}

/** Map a (possibly fractional) line from one document to the other. */
export function mapLine(
	anchors: LineAnchor[],
	line: number,
	from: "result" | "side",
): number {
	if (anchors.length === 0) return line;
	const key = from;
	const other = from === "result" ? "side" : "result";

	if (line <= anchors[0][key]) {
		return anchors[0][other] + (line - anchors[0][key]);
	}
	for (let i = 0; i < anchors.length - 1; i++) {
		const a = anchors[i];
		const b = anchors[i + 1];
		if (line <= b[key]) {
			const span = b[key] - a[key];
			const ratio = span === 0 ? 0 : (line - a[key]) / span;
			return a[other] + ratio * (b[other] - a[other]);
		}
	}
	const last = anchors[anchors.length - 1];
	return last[other] + (line - last[key]);
}

// ── Wiring ───────────────────────────────────────────────────────────────

interface Registered {
	ed: editor.IStandaloneCodeEditor;
	dispose: () => void;
	anchors: LineAnchor[];
}

interface Group {
	result?: Registered;
	sides: Map<string, Registered>;
}

const groups = new Map<string, Group>();
/** Guards the feedback loop: applying a scroll fires onDidScrollChange again. */
let applying = false;

function group(sourcePaneId: string): Group {
	let g = groups.get(sourcePaneId);
	if (!g) {
		g = { sides: new Map() };
		groups.set(sourcePaneId, g);
	}
	return g;
}

/**
 * Vertical offset of a (possibly fractional) line.
 *
 * Goes through `getTopForLineNumber` rather than multiplying by a single line
 * height. With word wrap on — `CodeEditor` passes the user's `editorWordWrap`
 * setting to the side panes too — a wrapped line occupies several visual rows,
 * so a uniform height drifts further down the document with every wrap.
 */
function topOfLine(ed: editor.IStandaloneCodeEditor, line: number): number {
	const whole = Math.max(1, Math.floor(line));
	const top = ed.getTopForLineNumber(whole);
	const fraction = line - whole;
	if (fraction <= 0) return top;
	// Interpolate within the line's own height, which is its wrapped height.
	return top + fraction * (ed.getTopForLineNumber(whole + 1) - top);
}

/** Inverse of `topOfLine`: the fractional line at the top of the viewport. */
function topLine(ed: editor.IStandaloneCodeEditor): number {
	const target = ed.getScrollTop();
	if (target <= 0) return 1;
	const lineCount = ed.getModel()?.getLineCount() ?? 1;

	// Binary search rather than a division: line offsets are monotonic but not
	// evenly spaced once any line wraps.
	let low = 1;
	let high = lineCount;
	while (low < high) {
		const mid = Math.floor((low + high + 1) / 2);
		if (ed.getTopForLineNumber(mid) <= target) low = mid;
		else high = mid - 1;
	}
	const top = ed.getTopForLineNumber(low);
	const next = ed.getTopForLineNumber(Math.min(low + 1, lineCount + 1));
	const height = next - top;
	return height > 0 ? low + (target - top) / height : low;
}

function scrollToLine(ed: editor.IStandaloneCodeEditor, line: number): void {
	ed.setScrollTop(Math.max(0, topOfLine(ed, line)));
}

function broadcast(
	sourcePaneId: string,
	resultLine: number,
	exceptPaneId?: string,
) {
	if (applying) return;
	applying = true;
	try {
		const g = groups.get(sourcePaneId);
		if (!g) return;
		if (g.result && exceptPaneId !== sourcePaneId) {
			scrollToLine(g.result.ed, resultLine);
		}
		for (const [paneId, side] of g.sides) {
			if (paneId === exceptPaneId) continue;
			scrollToLine(side.ed, mapLine(side.anchors, resultLine, "result"));
		}
	} finally {
		applying = false;
	}
}

/** Register the editable result pane of a Merge view. */
export function registerResultEditor(
	sourcePaneId: string,
	ed: editor.IStandaloneCodeEditor,
): () => void {
	const g = group(sourcePaneId);
	g.result?.dispose();
	const listener = ed.onDidScrollChange(() => {
		if (applying) return;
		broadcast(sourcePaneId, topLine(ed), sourcePaneId);
	});
	g.result = { ed, anchors: [], dispose: () => listener.dispose() };
	return () => {
		listener.dispose();
		const cur = groups.get(sourcePaneId);
		if (cur?.result?.ed === ed) cur.result = undefined;
		// Drop an emptied group, matching registerSideEditor — otherwise `groups`
		// keeps one dead entry per pane that ever had a Merge view open.
		if (cur && !cur.result && cur.sides.size === 0) groups.delete(sourcePaneId);
	};
}

/** Register one side pane, with its anchors against the result document. */
export function registerSideEditor(
	sourcePaneId: string,
	paneId: string,
	ed: editor.IStandaloneCodeEditor,
	anchors: LineAnchor[],
): () => void {
	const g = group(sourcePaneId);
	g.sides.get(paneId)?.dispose();
	const listener = ed.onDidScrollChange(() => {
		if (applying) return;
		const entry = groups.get(sourcePaneId)?.sides.get(paneId);
		if (!entry) return;
		broadcast(
			sourcePaneId,
			mapLine(entry.anchors, topLine(ed), "side"),
			paneId,
		);
	});
	g.sides.set(paneId, { ed, anchors, dispose: () => listener.dispose() });
	return () => {
		listener.dispose();
		const cur = groups.get(sourcePaneId);
		if (cur?.sides.get(paneId)?.ed === ed) cur.sides.delete(paneId);
		if (cur && !cur.result && cur.sides.size === 0) groups.delete(sourcePaneId);
	};
}

/** Exposed for tests — the wiring holds module state. */
export function resetMergeScrollSync(): void {
	groups.clear();
	applying = false;
}
