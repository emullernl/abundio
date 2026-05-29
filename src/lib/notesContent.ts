/**
 * Pure helpers for the per-Workspace Note's stored content.
 *
 * A Note is persisted as a TipTap/ProseMirror document serialized to a JSON
 * string (see ADR-0012). The backend treats it as opaque; these helpers are the
 * only place the frontend interprets that string — to seed the editor and to
 * decide whether a Note is effectively empty (for the empty state).
 */

/** A minimal valid TipTap document — a single empty paragraph. */
export const EMPTY_DOC = {
	type: "doc",
	content: [{ type: "paragraph" }],
} as const;

/**
 * Parse a stored Note string into a TipTap document object suitable for
 * `useEditor({ content })`. Tolerates an empty string (no note yet) and
 * malformed JSON by falling back to an empty document, so a corrupt row can
 * never wedge the editor.
 */
export function parseNoteContent(json: string | null | undefined): unknown {
	if (!json) return EMPTY_DOC;
	try {
		const parsed = JSON.parse(json);
		if (parsed && typeof parsed === "object") return parsed;
		return EMPTY_DOC;
	} catch {
		return EMPTY_DOC;
	}
}

/**
 * Whether a stored Note string carries no real content — used to show the
 * empty state. Treats an empty string, whitespace, and a lone empty paragraph
 * (TipTap's representation of a blank editor) as empty.
 */
export function isEmptyNoteContent(json: string | null | undefined): boolean {
	if (!json || json.trim() === "") return true;
	let doc: { content?: unknown };
	try {
		doc = JSON.parse(json);
	} catch {
		return true;
	}
	const content = doc?.content;
	if (!Array.isArray(content) || content.length === 0) return true;
	// A single empty paragraph (no children) is the blank-editor doc.
	if (content.length === 1) {
		const only = content[0] as { type?: string; content?: unknown };
		if (only?.type === "paragraph" && !only.content) return true;
	}
	return false;
}
