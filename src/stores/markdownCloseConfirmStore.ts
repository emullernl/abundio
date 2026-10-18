import { create } from "zustand";
import { markdownWindows } from "../lib/ipc";

/**
 * Asks about unsaved edits in **Markdown windows** before their owner closes
 * them (ADR-0046): closing a Workspace, switching Profile, closing the Window.
 *
 * The edits live in another webview, so this Window cannot see them. Each
 * Markdown window reports its own state to Rust, and this asks Rust.
 */
interface Pending {
	workspaceIds: string[];
	fileNames: string[];
	labels: string[];
	resolve: (proceed: boolean) => void;
}

interface MarkdownCloseConfirmState {
	pending: Pending | null;
	/** File names a Save could not save. Shown as a notice; the close that
	 *  asked for the save did not happen. */
	saveFailed: string[] | null;
}

export const useMarkdownCloseConfirmStore = create<MarkdownCloseConfirmState>(
	() => ({ pending: null, saveFailed: null }),
);

export function dismissMarkdownSaveFailed(): void {
	useMarkdownCloseConfirmStore.setState({ saveFailed: null });
}

const nameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/** How long "Save" waits for every window to report itself saved. */
const SAVE_TIMEOUT_MS = 5000;
const SAVE_POLL_MS = 100;

/**
 * Resolves `true` when the close may go ahead: nothing unsaved, or the user
 * chose Save (and every save landed) or Don't Save. `false` on Cancel, or
 * when a save did not land in time.
 *
 * A failure to *ask* does not block the close: a broken IPC must never trap
 * the user in a Window they are trying to close.
 */
export async function confirmMarkdownWindowsClean(
	workspaceIds: readonly string[],
): Promise<boolean> {
	if (workspaceIds.length === 0) return true;
	let dirty: Awaited<ReturnType<typeof markdownWindows.dirty>>;
	try {
		dirty = await markdownWindows.dirty([...workspaceIds]);
	} catch {
		return true;
	}
	if (dirty.length === 0) return true;
	// A second request (the close button clicked again while the dialog is
	// up) replaces the first; settle the first as cancelled, or its caller
	// would wait forever.
	useMarkdownCloseConfirmStore.getState().pending?.resolve(false);
	return new Promise<boolean>((resolve) => {
		useMarkdownCloseConfirmStore.setState({
			pending: {
				workspaceIds: [...workspaceIds],
				fileNames: dirty.map((d) => nameOf(d.filePath)),
				labels: dirty.map((d) => d.label),
				resolve,
			},
		});
	});
}

export async function resolveMarkdownClose(
	choice: "save" | "discard" | "cancel",
): Promise<void> {
	const pending = useMarkdownCloseConfirmStore.getState().pending;
	useMarkdownCloseConfirmStore.setState({ pending: null });
	if (!pending) return;
	if (choice === "cancel") return pending.resolve(false);
	if (choice === "discard") return pending.resolve(true);
	try {
		await markdownWindows.save(pending.labels);
		const saved = await waitUntil(
			async () => {
				const still = await markdownWindows.dirty(pending.workspaceIds);
				return still.every((d) => !pending.labels.includes(d.label));
			},
			SAVE_TIMEOUT_MS,
			SAVE_POLL_MS,
		);
		if (!saved) await reportSaveFailed(pending);
		pending.resolve(saved);
	} catch (e) {
		console.error("[markdownCloseConfirm] save failed:", e);
		await reportSaveFailed(pending);
		pending.resolve(false);
	}
}

/** Names the windows that are still unsaved; falls back to every window the
 *  save was asked of when Rust cannot be asked. */
async function reportSaveFailed(pending: Pending): Promise<void> {
	let names = pending.fileNames;
	try {
		const still = await markdownWindows.dirty(pending.workspaceIds);
		const failed = still.filter((d) => pending.labels.includes(d.label));
		if (failed.length > 0) names = failed.map((d) => nameOf(d.filePath));
	} catch {
		// Keep the full list.
	}
	useMarkdownCloseConfirmStore.setState({ saveFailed: names });
}

/** The notice shown when Save did not land: what failed, and that nothing
 *  was closed. */
export function saveFailedMessage(names: readonly string[]): string {
	const where =
		names.length === 1 ? "its Markdown window" : "their Markdown windows";
	return `Abundio could not save ${describeFiles(names)}, so nothing was closed. Your edits are still in ${where}. Check that the file can be written, then try again.`;
}

/** Polls `check` until it is true or `timeoutMs` passes. */
export async function waitUntil(
	check: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

/** "README.md", "README.md and guide.md", "README.md and 2 others". */
export function describeFiles(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} and ${names.length - 1} others`;
}
