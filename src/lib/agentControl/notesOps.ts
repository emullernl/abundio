// `notes read` and `notes append` (ADR-0056). A note is edited only in the
// Window that has its Profile, which is the Window Rust routes the call to,
// so this Window's store is the freshest copy: newer than the database while
// a save is pending.

import type { Content } from "@tiptap/react";
import { useNotesStore } from "../../stores/notesStore";
import { parseNoteContent } from "../notesContent";
import { notesEditorFor } from "../notesEditors";
import { appendToDoc, noteToText, textToNodes } from "../notesText";
import { ControlError } from "./types";

async function loaded(workspaceId: string): Promise<string> {
	await useNotesStore.getState().loadNote(workspaceId);
	const s = useNotesStore.getState();
	if (!s.loadedWorkspaceIds.has(workspaceId)) {
		throw new ControlError("internal", "the notes could not be read");
	}
	return s.contentByWorkspaceId[workspaceId] ?? "";
}

export async function readNotes(workspaceId: string): Promise<string> {
	return noteToText(parseNoteContent(await loaded(workspaceId)));
}

export async function appendNotes(
	workspaceId: string,
	text: string,
	byline: string,
): Promise<void> {
	const nodes = textToNodes(text, byline);
	const editor = notesEditorFor(workspaceId);
	if (editor) {
		// Through the open editor: its update writes the store, and the
		// user's selection is left where it is.
		if (editor.isEmpty) {
			editor.commands.setContent(nodes as Content, { emitUpdate: true });
		} else {
			editor.commands.insertContentAt(
				editor.state.doc.content.size,
				nodes as Content,
				{ updateSelection: false },
			);
		}
	} else {
		const current = await loaded(workspaceId);
		useNotesStore
			.getState()
			.updateNoteLocal(
				workspaceId,
				JSON.stringify(appendToDoc(parseNoteContent(current), nodes)),
			);
	}
	await useNotesStore.getState().flushNote(workspaceId);
}
