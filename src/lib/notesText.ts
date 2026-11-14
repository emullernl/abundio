// A Workspace's note as plain text for Agents (ADR-0056): `notes read`
// turns the stored editor document into Markdown-like text, and
// `notes append`, `notes write` and `notes edit` turn an Agent's text back
// into editor nodes. Pure.
//
// The editor allows paragraphs, hard breaks, bullet lists, task lists
// (nested) and bold / italic / strike marks (`NotesEditor.tsx`), so that is
// all this knows.

export interface DocNode {
	type: string;
	text?: string;
	marks?: { type: string }[];
	attrs?: Record<string, unknown>;
	content?: DocNode[];
}

function inline(nodes: DocNode[] | undefined): string {
	let out = "";
	for (const n of nodes ?? []) {
		if (n.type === "hardBreak") {
			out += "\n";
			continue;
		}
		if (n.type !== "text") continue;
		let t = n.text ?? "";
		const marks = new Set((n.marks ?? []).map((m) => m.type));
		if (marks.has("strike")) t = `~~${t}~~`;
		if (marks.has("italic")) t = `*${t}*`;
		if (marks.has("bold")) t = `**${t}**`;
		out += t;
	}
	return out;
}

function blocks(nodes: DocNode[] | undefined, indent: string): string[] {
	const out: string[] = [];
	for (const n of nodes ?? []) {
		switch (n.type) {
			case "paragraph":
				out.push(indent + inline(n.content).replace(/\n/g, `\n${indent}`));
				break;
			case "bulletList":
			case "taskList":
				for (const item of n.content ?? []) {
					const box =
						item.type === "taskItem"
							? item.attrs?.checked
								? "[x] "
								: "[ ] "
							: "";
					const [first, ...rest] = item.content ?? [];
					const head = first?.type === "paragraph" ? inline(first.content) : "";
					out.push(`${indent}- ${box}${head}`);
					out.push(...blocks(rest, `${indent}  `));
				}
				break;
			default:
				if (n.content) out.push(...blocks(n.content, indent));
		}
	}
	return out;
}

/** The note as text: one line per paragraph or list item, nested items
 *  indented by two spaces. */
export function noteToText(doc: unknown): string {
	const root = doc as DocNode | null;
	if (!root || !Array.isArray(root.content)) return "";
	return blocks(root.content, "")
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const ITEM = /^( *)[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/;
const TASK_BOX = /^( *)[-*]\s+\[( |x|X)\]\s/;

function textNode(text: string, marks: string[] = []): DocNode {
	return marks.length
		? { type: "text", text, marks: marks.map((type) => ({ type })) }
		: { type: "text", text };
}

/** Inline text with `**bold**`, `*italic*` and `~~strike~~` turned back into
 *  marks, the reverse of what `notes read` prints. A delimiter with no
 *  closing one later on stays as typed. */
export function parseInline(text: string): DocNode[] {
	const out: DocNode[] = [];
	const active: string[] = [];
	let buf = "";
	const flush = () => {
		if (buf) out.push(textNode(buf, [...active].sort()));
		buf = "";
	};
	const delims: [string, string][] = [
		["**", "bold"],
		["~~", "strike"],
		["*", "italic"],
	];
	let i = 0;
	outer: while (i < text.length) {
		for (const [d, mark] of delims) {
			if (!text.startsWith(d, i)) continue;
			const at = active.indexOf(mark);
			if (at >= 0) {
				flush();
				active.splice(at, 1);
				i += d.length;
				continue outer;
			}
			if (text.indexOf(d, i + d.length + 1) > 0) {
				flush();
				active.push(mark);
				i += d.length;
				continue outer;
			}
		}
		buf += text[i];
		i++;
	}
	flush();
	return out;
}

function paragraph(text: string): DocNode {
	const content = parseInline(text);
	return content.length
		? { type: "paragraph", content }
		: { type: "paragraph" };
}

interface Line {
	depth: number;
	kind: "task" | "bullet" | "paragraph";
	checked: boolean;
	text: string;
}

function lines(text: string): Line[] {
	const out: Line[] = [];
	// A line may nest at most one level below the item before it.
	let deepest = 0;
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		const item = ITEM.exec(raw);
		const spaces = (item ? item[1] : (/^ */.exec(raw)?.[0] ?? "")).length;
		const depth = Math.min(Math.floor(spaces / 2), deepest);
		if (item) {
			const task = TASK_BOX.test(raw);
			out.push({
				depth,
				kind: task ? "task" : "bullet",
				checked: task && item[2] !== " ",
				text: item[3].trim(),
			});
			deepest = depth + 1;
		} else {
			out.push({ depth, kind: "paragraph", checked: false, text: raw.trim() });
			deepest = depth;
		}
	}
	return out;
}

function build(ls: Line[], at: { i: number }, depth: number): DocNode[] {
	const nodes: DocNode[] = [];
	while (at.i < ls.length && ls[at.i].depth >= depth) {
		const l = ls[at.i++];
		if (l.kind === "paragraph") {
			nodes.push(paragraph(l.text));
			continue;
		}
		const item: DocNode =
			l.kind === "task"
				? {
						type: "taskItem",
						attrs: { checked: l.checked },
						content: [paragraph(l.text)],
					}
				: { type: "listItem", content: [paragraph(l.text)] };
		item.content?.push(...build(ls, at, depth + 1));
		const listType = l.kind === "task" ? "taskList" : "bulletList";
		const last = nodes[nodes.length - 1];
		if (last?.type === listType) last.content?.push(item);
		else nodes.push({ type: listType, content: [item] });
	}
	return nodes;
}

/** An Agent's text as editor nodes: `- [ ] ` / `- [x] ` lines become a task
 *  list, `- ` lines a bullet list, other lines paragraphs; two more spaces
 *  of indent nest a line under the item above, and blank lines are
 *  dropped. Bold, italic and strike come back as marks. */
export function textToBlocks(text: string): DocNode[] {
	return build(lines(text), { i: 0 }, 0);
}

/** `textToBlocks`, with `byline` in bold at the start (`notes append`). */
export function textToNodes(text: string, byline: string): DocNode[] {
	const nodes = textToBlocks(text);
	const sign = textNode(`${byline}:`, ["bold"]);
	const first = nodes[0];
	if (first?.type === "paragraph") {
		first.content = [sign, textNode(" "), ...(first.content ?? [])];
	} else {
		nodes.unshift({ type: "paragraph", content: [sign] });
	}
	return nodes;
}

// ── notes write / notes edit ──

/** One editable piece of a note: a top-level paragraph, or one item of a
 *  top-level list (with what is nested under it). */
interface Unit {
	node: DocNode;
	list?: { type: string; attrs?: Record<string, unknown> };
}

function toUnits(nodes: DocNode[]): Unit[] {
	const out: Unit[] = [];
	for (const n of nodes) {
		if (n.type === "bulletList" || n.type === "taskList") {
			for (const item of n.content ?? []) {
				out.push({ node: item, list: { type: n.type, attrs: n.attrs } });
			}
		} else {
			out.push({ node: n });
		}
	}
	return out;
}

function fromUnits(units: Unit[]): DocNode[] {
	const out: DocNode[] = [];
	for (const u of units) {
		if (!u.list) {
			out.push(u.node);
			continue;
		}
		const last = out[out.length - 1];
		if (last?.type === u.list.type) last.content?.push(u.node);
		else
			out.push({
				type: u.list.type,
				...(u.list.attrs ? { attrs: u.list.attrs } : {}),
				content: [u.node],
			});
	}
	return out;
}

function unitText(u: Unit): string {
	const node = u.list ? { type: u.list.type, content: [u.node] } : u.node;
	return blocks([node], "").join("\n");
}

function asDoc(nodes: DocNode[]): DocNode {
	return {
		type: "doc",
		content: nodes.length ? nodes : [{ type: "paragraph" }],
	};
}

/** `notes write`: the whole note from an Agent's text. */
export function textToDoc(text: string): DocNode {
	return asDoc(textToBlocks(text));
}

export type EditResult =
	| { ok: true; doc: DocNode }
	| { ok: false; reason: "not_found" | "ambiguous" };

/**
 * `notes edit`: replace the one place `old` appears in the note's text (as
 * `notes read` prints it) with `replacement`. Only the paragraphs and list
 * items the match touches are rebuilt from text; every other part of the
 * note is kept as it was.
 */
export function editDoc(
	doc: unknown,
	old: string,
	replacement: string,
): EditResult {
	const root = doc as DocNode | null;
	const units = toUnits(
		Array.isArray(root?.content) ? (root?.content ?? []) : [],
	);
	const texts = units.map(unitText);
	const full = texts.join("\n");
	const at = full.indexOf(old);
	if (at < 0) return { ok: false, reason: "not_found" };
	if (full.indexOf(old, at + 1) >= 0) return { ok: false, reason: "ambiguous" };
	const end = at + old.length;
	const starts: number[] = [];
	let offset = 0;
	for (const t of texts) {
		starts.push(offset);
		offset += t.length + 1;
	}
	let first = 0;
	let last = 0;
	for (let k = 0; k < units.length; k++) {
		if (starts[k] <= at) first = k;
		if (starts[k] < end) last = k;
	}
	const unitEnd = starts[last] + texts[last].length;
	const rebuilt =
		full.slice(starts[first], at) + replacement + full.slice(end, unitEnd);
	return {
		ok: true,
		doc: asDoc(
			fromUnits([
				...units.slice(0, first),
				...toUnits(textToBlocks(rebuilt)),
				...units.slice(last + 1),
			]),
		),
	};
}

/** `doc` with `nodes` added at the end. An empty note (nothing, or one empty
 *  paragraph) is replaced rather than kept as a blank first line. */
export function appendToDoc(doc: unknown, nodes: DocNode[]): DocNode {
	const root = doc as DocNode | null;
	const existing = Array.isArray(root?.content) ? (root?.content ?? []) : [];
	const blank =
		existing.length === 0 ||
		(existing.length === 1 &&
			existing[0].type === "paragraph" &&
			!existing[0].content?.length);
	return { type: "doc", content: blank ? nodes : [...existing, ...nodes] };
}
