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
}

export const useMarkdownCloseConfirmStore = create<MarkdownCloseConfirmState>(
	() => ({ pending: null }),
);

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
	return new Promise<boolean>((resolve) => {
		useMarkdownCloseConfirmStore.setState({
			pending: {
				workspaceIds: [...workspaceIds],
				fileNames: dirty.map((d) => d.filePath.split("/").pop() || d.filePath),
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
		pending.resolve(saved);
	} catch (e) {
		console.error("[markdownCloseConfirm] save failed:", e);
		pending.resolve(false);
	}
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
