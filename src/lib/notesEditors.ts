import type { Editor } from "@tiptap/react";

// The Notes editor open for each Workspace, so an Agent's `notes append`
// (ADR-0056) goes through it: the user's cursor and unsaved typing stay as
// they are, and its own update writes the note.

const editors = new Map<string, Editor>();

export function registerNotesEditor(workspaceId: string, editor: Editor) {
	editors.set(workspaceId, editor);
	return () => {
		if (editors.get(workspaceId) === editor) editors.delete(workspaceId);
	};
}

export function notesEditorFor(workspaceId: string): Editor | undefined {
	const e = editors.get(workspaceId);
	return e && !e.isDestroyed ? e : undefined;
}
