// `notes read`, `notes append`, `notes write` and `notes edit` (ADR-0056). A note is edited only in the
// Window that has its Profile, which is the Window Rust routes the call to,
// so this Window's store is the freshest copy: newer than the database while
// a save is pending.

import type { Content } from "@tiptap/react";
import { useNotesStore } from "../../stores/notesStore";
import { parseNoteContent } from "../notesContent";
import { notesEditorFor } from "../notesEditors";
import {
	appendToDoc,
	type DocNode,
	editDoc,
	noteToText,
	textToDoc,
	textToNodes,
} from "../notesText";
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

/** Put a whole new document in the note. Through the open editor when there
 *  is one, as one step the user can undo, keeping their cursor near where
 *  it was. */
async function replaceNote(workspaceId: string, doc: DocNode): Promise<void> {
	const editor = notesEditorFor(workspaceId);
	if (editor) {
		const { from, to } = editor.state.selection;
		editor.commands.setContent(doc as Content, { emitUpdate: true });
		const size = editor.state.doc.content.size;
		editor.commands.setTextSelection({
			from: Math.min(from, size),
			to: Math.min(to, size),
		});
	} else {
		useNotesStore.getState().updateNoteLocal(workspaceId, JSON.stringify(doc));
	}
	await useNotesStore.getState().flushNote(workspaceId);
}

export async function writeNotes(workspaceId: string, text: string) {
	await loaded(workspaceId);
	await replaceNote(workspaceId, textToDoc(text));
}

export async function editNotes(
	workspaceId: string,
	old: string,
	replacement: string,
): Promise<void> {
	const editor = notesEditorFor(workspaceId);
	const current = editor
		? editor.getJSON()
		: parseNoteContent(await loaded(workspaceId));
	const r = editDoc(current, old, replacement);
	if (!r.ok) {
		throw r.reason === "not_found"
			? new ControlError(
					"not_found",
					"that text is not in the notes; copy it exactly from `abundio notes read`",
				)
			: new ControlError(
					"ambiguous",
					"that text appears more than once in the notes; quote more of it",
				);
	}
	await replaceNote(workspaceId, r.doc);
}
