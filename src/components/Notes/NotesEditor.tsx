import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { type Content, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { parseNoteContent } from "../../lib/notesContent";
import { useNotesStore } from "../../stores/notesStore";
import { NotesToolbar } from "./NotesToolbar";
import "./Notes.css";

interface Props {
	/** The Workspace this editor edits. The parent keys the component on this,
	 *  so a workspace switch remounts the editor with fresh content/cursor. */
	workspaceId: string;
	/** The note's stored TipTap JSON at mount time (seeds the editor once). */
	initialContent: string;
}

/** Cherry-picked StarterKit: a notepad, not a document editor. Headings,
 *  ordered lists, code, blockquotes, rules, links and underline are off; bold,
 *  italic, strike, bullet lists, paragraphs, history and hard breaks stay. Task
 *  lists (checklists) are added on top. */
const EXTENSIONS = [
	StarterKit.configure({
		heading: false,
		orderedList: false,
		codeBlock: false,
		blockquote: false,
		horizontalRule: false,
		code: false,
		link: false,
		underline: false,
	}),
	TaskList,
	TaskItem.configure({ nested: true }),
	Placeholder.configure({ placeholder: "Write a note…" }),
];

export function NotesEditor({ workspaceId, initialContent }: Props) {
	const updateNoteLocal = useNotesStore((s) => s.updateNoteLocal);
	const flushNote = useNotesStore((s) => s.flushNote);

	const editor = useEditor({
		extensions: EXTENSIONS,
		content: parseNoteContent(initialContent) as Content,
		onUpdate: ({ editor }) => {
			updateNoteLocal(workspaceId, JSON.stringify(editor.getJSON()));
		},
		onBlur: () => {
			flushNote(workspaceId).catch(() => {});
		},
		editorProps: {
			attributes: { class: "notes-prosemirror" },
		},
	});

	return (
		<div className="flex flex-col h-full min-h-0">
			<NotesToolbar editor={editor} />
			<EditorContent
				editor={editor}
				className="flex-1 min-h-0 overflow-y-auto"
			/>
		</div>
	);
}
