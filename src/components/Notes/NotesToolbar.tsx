import { type Editor, useEditorState } from "@tiptap/react";
import { sc } from "../../lib/platform";
import { Bold, Italic, ListBullet, ListChecks, Strikethrough } from "../Icons";

interface Props {
	editor: Editor | null;
}

function ToolbarButton({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean;
	onClick: () => void;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			// Keep focus in the editor so toggling a mark applies to the selection.
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
			title={title}
			className="flex items-center justify-center rounded transition-colors"
			style={{
				width: 26,
				height: 24,
				color: active ? "var(--accent)" : "var(--fg-secondary)",
				backgroundColor: active
					? "color-mix(in srgb, var(--accent) 15%, transparent)"
					: "transparent",
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				if (!active) e.currentTarget.style.color = "var(--fg-primary)";
			}}
			onMouseLeave={(e) => {
				if (!active) e.currentTarget.style.color = "var(--fg-secondary)";
			}}
		>
			{children}
		</button>
	);
}

/** Slim persistent toolbar above the note editor: bold / italic / strike /
 *  bullet list / checklist. Active state tracks the cursor via useEditorState
 *  so a button highlights when the caret sits inside that mark/list. */
export function NotesToolbar({ editor }: Props) {
	const state = useEditorState({
		editor,
		selector: ({ editor }) =>
			editor
				? {
						bold: editor.isActive("bold"),
						italic: editor.isActive("italic"),
						strike: editor.isActive("strike"),
						bulletList: editor.isActive("bulletList"),
						taskList: editor.isActive("taskList"),
					}
				: null,
	});

	if (!editor || !state) return null;

	return (
		<div
			className="flex items-center gap-0.5 flex-shrink-0"
			style={{
				height: 32,
				paddingLeft: 8,
				paddingRight: 8,
				borderBottom: "1px solid var(--border)",
			}}
		>
			<ToolbarButton
				active={state.bold}
				title={`Bold (${sc("⌘B", "Ctrl+B")})`}
				onClick={() => editor.chain().focus().toggleBold().run()}
			>
				<Bold size={15} />
			</ToolbarButton>
			<ToolbarButton
				active={state.italic}
				title={`Italic (${sc("⌘I", "Ctrl+I")})`}
				onClick={() => editor.chain().focus().toggleItalic().run()}
			>
				<Italic size={15} />
			</ToolbarButton>
			<ToolbarButton
				active={state.strike}
				title="Strikethrough"
				onClick={() => editor.chain().focus().toggleStrike().run()}
			>
				<Strikethrough size={15} />
			</ToolbarButton>
			<div
				style={{
					width: 1,
					height: 16,
					background: "var(--border)",
					margin: "0 4px",
				}}
			/>
			<ToolbarButton
				active={state.bulletList}
				title="Bullet list"
				onClick={() => editor.chain().focus().toggleBulletList().run()}
			>
				<ListBullet size={15} />
			</ToolbarButton>
			<ToolbarButton
				active={state.taskList}
				title="Checklist"
				onClick={() => editor.chain().focus().toggleTaskList().run()}
			>
				<ListChecks size={15} />
			</ToolbarButton>
		</div>
	);
}
