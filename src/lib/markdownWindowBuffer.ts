/**
 * The edit buffer of a **Markdown window**, as pure transitions.
 *
 * A Markdown window keeps its own buffer, separate from any File pane on the
 * same file (ADR-0046): a save on either side reaches the other as an external
 * change. So the window has to tell its own save coming back from the watcher
 * apart from someone else's write — it does that by comparing the disk content
 * with what it last saved.
 */
export interface MarkdownBuffer {
	/** What is on disk, as far as this window knows. */
	saved: string;
	/** What the user sees and edits. */
	content: string;
	/** Disk changed while the buffer had unsaved edits. */
	externallyChanged: boolean;
	/** The disk content that caused `externallyChanged`. */
	pendingDisk: string | null;
	deletedOnDisk: boolean;
}

export function loadedBuffer(content: string): MarkdownBuffer {
	return {
		saved: content,
		content,
		externallyChanged: false,
		pendingDisk: null,
		deletedOnDisk: false,
	};
}

export function isDirty(b: MarkdownBuffer): boolean {
	return b.content !== b.saved;
}

export function edited(b: MarkdownBuffer, content: string): MarkdownBuffer {
	return { ...b, content };
}

/** The file's content as just read from disk after a change event. */
export function diskChanged(b: MarkdownBuffer, disk: string): MarkdownBuffer {
	// Our own save echoing back, or a touch that changed nothing.
	if (disk === b.saved) return { ...b, deletedOnDisk: false };
	if (!isDirty(b)) return loadedBuffer(disk);
	return {
		...b,
		externallyChanged: true,
		pendingDisk: disk,
		deletedOnDisk: false,
	};
}

export function diskRemoved(b: MarkdownBuffer): MarkdownBuffer {
	return { ...b, deletedOnDisk: true, externallyChanged: false };
}

/** "Reload from disk": drop the edits. */
export function reloaded(b: MarkdownBuffer): MarkdownBuffer {
	return loadedBuffer(b.pendingDisk ?? b.saved);
}

/** "Keep my edits": the disk version becomes the baseline, so the buffer is
 *  still dirty against it and a later save overwrites it. */
export function keptEdits(b: MarkdownBuffer): MarkdownBuffer {
	return {
		...b,
		saved: b.pendingDisk ?? b.saved,
		externallyChanged: false,
		pendingDisk: null,
	};
}

export function savedBuffer(b: MarkdownBuffer): MarkdownBuffer {
	return loadedBuffer(b.content);
}
