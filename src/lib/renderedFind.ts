/**
 * Find in the rendered view of a **Markdown window**. The source view has
 * Monaco's own Find; rendered HTML has nothing, so matches are found over the
 * DOM's text nodes and painted with the CSS Custom Highlight API, which marks
 * text without touching the DOM React owns.
 */

/** Start/end offsets of every case-insensitive match of `query` in `text`. */
export function findMatches(
	text: string,
	query: string,
): Array<[number, number]> {
	if (!query) return [];
	const hay = text.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	// Lower-casing can change length (e.g. "İ"); fall back to exact matching
	// rather than paint offsets that point at the wrong characters.
	const [h, n] =
		hay.length === text.length && needle.length === query.length
			? [hay, needle]
			: [text, query];
	const out: Array<[number, number]> = [];
	let from = 0;
	for (;;) {
		const at = h.indexOf(n, from);
		if (at < 0) break;
		out.push([at, at + n.length]);
		from = at + n.length;
	}
	return out;
}

/** A DOM Range per match. A match never spans two text nodes: a word split
 *  by inline markup (`**bo**ld`) is not found, which is the usual trade. */
export function findRanges(root: Node, query: string): Range[] {
	const ranges: Range[] = [];
	if (!query) return ranges;
	const doc = root.ownerDocument ?? document;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.nodeValue ?? "";
		for (const [start, end] of findMatches(text, query)) {
			const range = doc.createRange();
			range.setStart(node, start);
			range.setEnd(node, end);
			ranges.push(range);
		}
	}
	return ranges;
}

const ALL = "abundio-md-find";
const CURRENT = "abundio-md-find-current";

interface HighlightRegistry {
	set(name: string, h: unknown): void;
	delete(name: string): void;
}

function registry(): {
	highlights: HighlightRegistry;
	Highlight: new (...r: Range[]) => unknown;
} | null {
	const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
	const Highlight = (
		globalThis as { Highlight?: new (...r: Range[]) => unknown }
	).Highlight;
	if (!css?.highlights || !Highlight) return null;
	return { highlights: css.highlights, Highlight };
}

/** Paints every match, the current one distinctly, and scrolls to it. */
export function paintMatches(ranges: Range[], current: number): void {
	const reg = registry();
	if (reg) {
		reg.highlights.set(ALL, new reg.Highlight(...ranges));
		const cur = ranges[current];
		if (cur) reg.highlights.set(CURRENT, new reg.Highlight(cur));
		else reg.highlights.delete(CURRENT);
	}
	const target = ranges[current]?.startContainer.parentElement;
	target?.scrollIntoView({ block: "center" });
}

export function clearMatches(): void {
	const reg = registry();
	reg?.highlights.delete(ALL);
	reg?.highlights.delete(CURRENT);
}
