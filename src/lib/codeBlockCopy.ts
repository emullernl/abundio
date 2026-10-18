/** Walk a hast node collecting text — code children may be highlighted spans. */
// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
export function hastText(node: any): string {
	if (!node) return "";
	if (node.type === "text") return node.value ?? "";
	if (Array.isArray(node.children)) return node.children.map(hastText).join("");
	return "";
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
