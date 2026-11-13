// A Workspace's note as plain text for Agents (ADR-0056): `notes read`
// turns the stored editor document into Markdown-like text, and
// `notes append` turns an Agent's text into editor nodes. Pure.
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

const TASK = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

function textNode(text: string, bold = false): DocNode {
	return bold
		? { type: "text", text, marks: [{ type: "bold" }] }
		: { type: "text", text };
}

function paragraph(text: string): DocNode {
	return text
		? { type: "paragraph", content: [textNode(text)] }
		: { type: "paragraph" };
}

/**
 * An Agent's text as editor nodes: `- [ ] ` / `- [x] ` lines become a task
 * list, `- ` lines a bullet list, other lines paragraphs, and blank lines
 * are dropped. The first node starts with `byline` in bold.
 */
export function textToNodes(text: string, byline: string): DocNode[] {
	const nodes: DocNode[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const task = TASK.exec(line);
		const bullet = task ? null : BULLET.exec(line);
		if (task) {
			const item: DocNode = {
				type: "taskItem",
				attrs: { checked: task[1] !== " " },
				content: [paragraph(task[2].trim())],
			};
			const last = nodes[nodes.length - 1];
			if (last?.type === "taskList") last.content?.push(item);
			else nodes.push({ type: "taskList", content: [item] });
		} else if (bullet) {
			const item: DocNode = {
				type: "listItem",
				content: [paragraph(bullet[1].trim())],
			};
			const last = nodes[nodes.length - 1];
			if (last?.type === "bulletList") last.content?.push(item);
			else nodes.push({ type: "bulletList", content: [item] });
		} else {
			nodes.push(paragraph(line.trim()));
		}
	}
	const sign = textNode(`${byline}:`, true);
	const first = nodes[0];
	if (first?.type === "paragraph") {
		first.content = [sign, textNode(" "), ...(first.content ?? [])];
	} else {
		nodes.unshift({ type: "paragraph", content: [sign] });
	}
	return nodes;
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
