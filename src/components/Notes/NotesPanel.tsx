import { useEffect } from "react";
import { useNotesStore } from "../../stores/notesStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { NotesEditor } from "./NotesEditor";

/** Notes tab of the right sidebar: a single per-Workspace rich-text note.
 *  Gates on the note being loaded, then mounts the editor keyed on the
 *  workspace so a workspace switch swaps content with a clean cursor. The
 *  empty state is the editor's own placeholder — you can just start typing. */
export function NotesPanel() {
	const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
	const loadNote = useNotesStore((s) => s.loadNote);
	const loaded = useNotesStore((s) =>
		activeWorkspaceId ? s.loadedWorkspaceIds.has(activeWorkspaceId) : false,
	);
	const content = useNotesStore((s) =>
		activeWorkspaceId ? s.contentByWorkspaceId[activeWorkspaceId] : undefined,
	);

	useEffect(() => {
		if (activeWorkspaceId) loadNote(activeWorkspaceId);
	}, [activeWorkspaceId, loadNote]);

	if (!activeWorkspaceId) {
		return (
			<div
				className="flex items-center justify-center h-full"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				No active workspace
			</div>
		);
	}

	// Wait for the initial fetch so the editor seeds with the real content
	// rather than mounting empty and clobbering the note on first keystroke.
	if (!loaded) return <div className="h-full" />;

	return (
		<NotesEditor
			key={activeWorkspaceId}
			workspaceId={activeWorkspaceId}
			initialContent={content ?? ""}
		/>
	);
}
