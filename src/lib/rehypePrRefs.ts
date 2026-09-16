/**
 * Rehype plugin: turn GitHub's `#123` pull-request shorthand into a real link.
 *
 * GitHub's API returns a release's **raw** Markdown, so the auto-linking you see
 * on github.com has not happened yet — `#180` arrives as literal text. Abundio's
 * release notes lean on PR references, so without this nearly every line ends in
 * a dead `(#180)`.
 *
 * Deliberately narrow: `@mentions` and commit SHAs are left alone. A profile
 * link adds nothing to a release note, a bare hex string is too easy to confuse
 * with something that is not a SHA, and each extra pattern buys another class of
 * false positive for content we do not write.
 *
 * Must run **before** `rehype-sanitize`, which allows `<a href>` and would
 * otherwise see nothing to keep. It walks text nodes only and skips the subtrees
 * where a `#123` is not a reference: inside an existing link, and inside code.
 *
 * @see ADR-0036
 */

/** `#` followed by digits, not glued to a preceding word character. The leading
 *  boundary is what stops a CSS colour (`#123456` is still matched as `#123456`,
 *  but `abc#12` is not) and an anchor inside a word from being rewritten. */
const PR_REF = /(^|[^\w#])#(\d+)\b/g;

/** Elements whose text is never a PR reference. `a` because a link inside a
 *  link is invalid; `code`/`pre` because `#1` in a code sample is code; the
 *  heading case is handled by Markdown itself (`# 180` parses as a heading, so
 *  the `#` never reaches a text node). */
const SKIP_TAGS = new Set(["a", "code", "pre", "script", "style"]);

interface HastNode {
	type: string;
	tagName?: string;
	value?: string;
	children?: HastNode[];
	properties?: Record<string, unknown>;
}

function link(number: string, repoUrl: string): HastNode {
	return {
		type: "element",
		tagName: "a",
		properties: { href: `${repoUrl}/pull/${number}` },
		children: [{ type: "text", value: `#${number}` }],
	};
}

/** Splits one text node into the alternating text / link nodes it contains.
 *  Returns null when there is nothing to link, so the common case allocates
 *  nothing and the tree is left exactly as it was. */
function splitText(value: string, repoUrl: string): HastNode[] | null {
	PR_REF.lastIndex = 0;
	if (!PR_REF.test(value)) return null;
	PR_REF.lastIndex = 0;

	const out: HastNode[] = [];
	let cursor = 0;
	let match = PR_REF.exec(value);
	while (match !== null) {
		const [whole, prefix, number] = match;
		const start = match.index + prefix.length;
		if (start > cursor) {
			out.push({ type: "text", value: value.slice(cursor, start) });
		}
		out.push(link(number, repoUrl));
		cursor = match.index + whole.length;
		match = PR_REF.exec(value);
	}
	if (cursor < value.length) {
		out.push({ type: "text", value: value.slice(cursor) });
	}
	return out;
}

/** Rewrites a hast tree in place. Exported for tests — the plugin below is the
 *  thin wrapper rehype expects. */
export function linkifyPrRefs(tree: HastNode, repoUrl: string): void {
	const walk = (node: HastNode): void => {
		if (!Array.isArray(node.children)) return;
		if (node.tagName && SKIP_TAGS.has(node.tagName)) return;

		const rebuilt: HastNode[] = [];
		let changed = false;
		for (const child of node.children) {
			if (child.type === "text" && typeof child.value === "string") {
				const split = splitText(child.value, repoUrl);
				if (split) {
					rebuilt.push(...split);
					changed = true;
					continue;
				}
				rebuilt.push(child);
				continue;
			}
			walk(child);
			rebuilt.push(child);
		}
		if (changed) node.children = rebuilt;
	};
	walk(tree);
}

export function rehypePrRefs(options: { repoUrl: string }) {
	return (tree: HastNode) => linkifyPrRefs(tree, options.repoUrl);
}
