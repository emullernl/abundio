/**
 * **Missing folder** (ADR-0053) helpers shared by the store, the pane and
 * the pickers.
 */
import { FOLDER_MISSING_PREFIX } from "./ipc";

/** The `Folder not found: <path>` line from a spawn Rust refused for a
 *  Missing folder, or `null` for any other failure. */
export function folderMissingReason(err: unknown): string | null {
	const text = String(err);
	const at = text.indexOf(FOLDER_MISSING_PREFIX);
	return at === -1 ? null : text.slice(at);
}
