import type { Options as SanitizeSchema } from "rehype-sanitize";
import { defaultSchema } from "rehype-sanitize";

/**
 * Sanitization schema for the markdown preview pane.
 *
 * `@uiw/react-markdown-preview` bakes in `rehype-raw` (raw HTML in a `.md`
 * file becomes live DOM) but ships no sanitizer. A markdown file is untrusted
 * input — without this, opening one could inject `<iframe>`, `<img onerror>`,
 * `<style>`, `<base>` etc. into the app's webview origin. `rehype-sanitize`
 * runs after `rehype-raw` in @uiw's plugin chain and strips that surface.
 *
 * Extends GitHub's `defaultSchema` with the two attributes our own pipeline
 * relies on, which the default would otherwise drop:
 *  - `dataSourceLine` on every element — anchors stamped by `rehypeSourceLines`
 *    for editor↔preview scroll sync.
 *  - `class="anchor"` on `<a>` — added by @uiw's autolink-headings; PreviewPane.css
 *    targets it to hide the heading-anchor icon.
 */

type PropertyDefinition = NonNullable<
	SanitizeSchema["attributes"]
>[string][number];

// The default `a` schema already constrains `className` to a single allowed
// value (`data-footnote-backref`); hast-util-sanitize keys attribute specs by
// property name, so a second `className` entry would be ignored. Merge our
// `anchor` value into that one spec instead.
const anchorAttrs: PropertyDefinition[] = (
	defaultSchema.attributes?.a ?? []
).map(
	(attr): PropertyDefinition =>
		Array.isArray(attr) && attr[0] === "className" ? [...attr, "anchor"] : attr,
);

export const markdownSanitizeSchema: SanitizeSchema = {
	...defaultSchema,
	attributes: {
		...defaultSchema.attributes,
		"*": [...(defaultSchema.attributes?.["*"] ?? []), "dataSourceLine"],
		a: anchorAttrs,
	},
};
