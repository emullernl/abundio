/**
 * Walk a hast node collecting the text a reader can see — code children may be
 * highlighted spans. The sanitizer still lets raw HTML put two hidden elements
 * inside a `<pre>`, so their text is skipped, or a copy could carry a command
 * the reader never saw: `<rp>` (`display: none` inside `<ruby>`), and
 * everything in a `<details>` but its `<summary>` (hidden while collapsed,
 * and collapsed is the safe assumption).
 */
// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
export function hastText(node: any): string {
	if (!node) return "";
	if (node.type === "text") return node.value ?? "";
	if (node.type === "element" && node.tagName === "rp") return "";
	if (!Array.isArray(node.children)) return "";
	const children =
		node.type === "element" && node.tagName === "details"
			? node.children.filter(
					// biome-ignore lint/suspicious/noExplicitAny: hast node shape
					(c: any) => c.type === "element" && c.tagName === "summary",
				)
			: node.children;
	return children.map(hastText).join("");
}

/**
 * What a code block's copy button puts on the clipboard: the block's own code,
 * read from the same hast node that renders it, so the copy can never differ
 * from what is shown. (@uiw's built-in button copies a `data-code` attribute
 * instead, which raw HTML in a `.md` could set to anything.) The single trailing
 * newline the parser always adds is dropped, so a pasted one-line command does
 * not run by itself in a shell.
 */
// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
export function codeBlockCopyText(preNode: any): string {
	return hastText(preNode).replace(/\n$/, "");
}
