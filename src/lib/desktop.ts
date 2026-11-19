import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";
import {
	onAction as tauriOnAction,
	sendNotification as tauriSendNotification,
} from "@tauri-apps/plugin-notification";
import { open as tauriShellOpen } from "@tauri-apps/plugin-shell";
import { isDemoMode } from "./demo";

/**
 * The **desktop** side of the IPC seam: things that always happen on the
 * computer the app runs on, whatever Host a Workspace lives on (ADR-0062) —
 * opening a URL or file in another app, desktop notifications, native file
 * dialogs, the desktop user's home folder.
 *
 * Every Tauri plugin call outside `ipc.ts`, `appWindow.ts`, `clipboard.ts` and
 * `platform.ts` goes through here (`seamImports.test.ts` enforces it). Each
 * degrades in the browser demo, where there is no Tauri runtime.
 */

/** Open a URL (or path) with the desktop's default handler. */
export function openExternal(target: string): Promise<void> {
	if (isDemoMode()) {
		try {
			window.open(target, "_blank", "noopener");
		} catch {
			// A popup blocker may refuse; nothing else to do in the demo.
		}
		return Promise.resolve();
	}
	return tauriShellOpen(target);
}

type NotificationOptions = Parameters<typeof tauriSendNotification>[0];

/** Show a desktop notification. A no-op in the browser demo. */
export function sendNotification(options: NotificationOptions): void {
	if (isDemoMode()) return;
	tauriSendNotification(options);
}

/** Hear clicks on a desktop notification's actions. */
export function onNotificationAction(
	...args: Parameters<typeof tauriOnAction>
): ReturnType<typeof tauriOnAction> {
	return tauriOnAction(...args);
}

type OpenDialogOptions = Parameters<
	typeof import("@tauri-apps/plugin-dialog").open
>[0];
type SaveDialogOptions = Parameters<
	typeof import("@tauri-apps/plugin-dialog").save
>[0];

/** The native Open dialog. Loaded on demand; `null` when cancelled or in the
 *  browser demo. */
export async function openDialog(
	options?: OpenDialogOptions,
): Promise<string | string[] | null> {
	if (isDemoMode()) return null;
	const { open } = await import("@tauri-apps/plugin-dialog");
	return open(options);
}

/** The native Save dialog. `null` when cancelled or in the browser demo. */
export async function saveDialog(
	options?: SaveDialogOptions,
): Promise<string | null> {
	if (isDemoMode()) return null;
	const { save } = await import("@tauri-apps/plugin-dialog");
	return save(options);
}

/** The desktop user's home folder. Never a Host's: a remote Workspace's home
 *  comes from its Host. */
export function homeDir(): Promise<string> {
	if (isDemoMode()) return Promise.resolve("/Users/demo");
	return tauriHomeDir();
}
