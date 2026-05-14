/**
 * Rehype plugin: stamp every element with a `data-source-line` attribute
 * carrying its starting line in the markdown source. This gives the
 * editor↔preview scroll sync concrete anchor points to map between.
 *
 * `remark-rehype` keeps `position` on hast nodes by default, so this just
 * copies it onto `properties`. Elements that have lost their position (rare,
 * after some transforms) are simply skipped — the sync degrades to
 * proportional where anchors are sparse.
 */
export function rehypeSourceLines() {
	// biome-ignore lint/suspicious/noExplicitAny: hast tree — not worth pulling in @types/hast
	return (tree: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: hast node
		const walk = (node: any) => {
			if (
				node.type === "element" &&
				typeof node.position?.start?.line === "number"
			) {
				node.properties = node.properties ?? {};
				node.properties.dataSourceLine = node.position.start.line;
			}
			if (Array.isArray(node.children)) {
				for (const child of node.children) walk(child);
			}
		};
		walk(tree);
	};
}
