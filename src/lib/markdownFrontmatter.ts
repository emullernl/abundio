import { parse, stringify } from "yaml";

/**
 * **Frontmatter** in the rendered markdown (Preview pane and Markdown window).
 *
 * Without frontmatter support, `---\ntitle: x\n---` renders as a thematic
 * break followed by a setext `<h2>` — the closing `---` underlines the text
 * above it. `remark-frontmatter` makes the parser lift that block into a
 * `yaml` node; `remarkFrontmatterTable` then turns the node into a key/value
 * table, a raw code block (not a mapping, or invalid YAML), or nothing (empty).
 */

export interface FrontmatterRow {
	key: string;
	value: string;
	/** A nested mapping (or a list holding one), shown as its YAML text. */
	block: boolean;
}

export type FrontmatterView =
	| { kind: "empty" }
	| { kind: "raw" }
	| { kind: "table"; rows: FrontmatterRow[] };

function isScalar(value: unknown): boolean {
	return value === null || typeof value !== "object";
}

function scalarText(value: unknown): string {
	return value === null || value === undefined ? "" : String(value);
}

/** Pure: how a frontmatter block's YAML source should be shown. */
export function frontmatterView(source: string): FrontmatterView {
	let data: unknown;
	try {
		// `logLevel: "error"`: a warning is not worth a console line per render.
		data = parse(source, { logLevel: "error" });
	} catch {
		return { kind: "raw" };
	}
	// An empty block, or one holding only comments.
	if (data === null || data === undefined) return { kind: "empty" };
	if (typeof data !== "object" || Array.isArray(data)) return { kind: "raw" };

	const rows = Object.entries(data as Record<string, unknown>).map(
		([key, value]): FrontmatterRow => {
			if (isScalar(value)) {
				return { key, value: scalarText(value), block: false };
			}
			if (Array.isArray(value) && value.every(isScalar)) {
				return { key, value: value.map(scalarText).join(", "), block: false };
			}
			return { key, value: stringify(value).trimEnd(), block: true };
		},
	);
	return rows.length === 0 ? { kind: "empty" } : { kind: "table", rows };
}

// biome-ignore lint/suspicious/noExplicitAny: hast node
const text = (value: string): any => ({ type: "text", value });

// biome-ignore lint/suspicious/noExplicitAny: hast node
function rowElement(row: FrontmatterRow): any {
	const cell = row.block
		? [
				{
					type: "element",
					tagName: "code",
					properties: {},
					children: [text(row.value)],
				},
			]
		: [text(row.value)];
	return {
		type: "element",
		tagName: "tr",
		properties: {},
		children: [
			{
				type: "element",
				tagName: "th",
				properties: {},
				children: [text(row.key)],
			},
			{ type: "element", tagName: "td", properties: {}, children: cell },
		],
	};
}

/**
 * Remark plugin, run after `remark-frontmatter`. Replaces the leading `yaml`
 * node in place, keeping its `position` so `rehypeSourceLines` still anchors
 * line 1 for editor↔preview scroll sync.
 *
 * The table is described through `data.hName`/`hProperties`/`hChildren`,
 * which `remark-rehype` turns into the hast element for an unknown node type.
 */
export function remarkFrontmatterTable() {
	// biome-ignore lint/suspicious/noExplicitAny: mdast tree — not worth pulling in @types/mdast
	return (tree: any) => {
		const first = tree.children?.[0];
		if (first?.type !== "yaml") return;

		const view = frontmatterView(first.value ?? "");
		if (view.kind === "empty") {
			tree.children.splice(0, 1);
		} else if (view.kind === "raw") {
			tree.children[0] = {
				type: "code",
				lang: "yaml",
				value: first.value,
				position: first.position,
			};
		} else {
			tree.children[0] = {
				type: "frontmatter",
				position: first.position,
				data: {
					hName: "table",
					hProperties: { className: ["frontmatter"] },
					hChildren: [
						{
							type: "element",
							tagName: "tbody",
							properties: {},
							children: view.rows.map(rowElement),
						},
					],
				},
			};
		}
	};
}
