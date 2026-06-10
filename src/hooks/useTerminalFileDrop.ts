import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { isDemoMode } from "../lib/demo";
import { buildDropText, type DropMode, isImagePath } from "../lib/fileDrop";
import { useFileDropStore } from "../lib/fileDropStore";
import { clipboardImage, pty } from "../lib/ipc";
import { getTerminal } from "../lib/terminalManager";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";

// Ctrl+V control byte. Agents that support clipboard-image paste (Claude Code,
// Gemini CLI) read the OS clipboard when they receive this on stdin.
const CTRL_V = "\x16";

/** Map a webview drop position (physical px) to the terminal pane under it.
 *  `document.elementFromPoint` wants CSS px, so divide out the device ratio. */
function paneIdAtPoint(physX: number, physY: number): string | null {
	const dpr = window.devicePixelRatio || 1;
	const el = document.elementFromPoint(physX / dpr, physY / dpr);
	return el?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null;
}

/**
 * Drop OS files onto terminal panes. Registered once per Window in App.tsx.
 *
 * Base behaviour: dropping file(s) onto a terminal pane inserts their path(s)
 * (mode-aware: raw for agents, shell-quoted for plain shells), via bracketed
 * paste so nothing executes. Smart image drop: a single image dropped onto an
 * agent-mode pane (with the setting on) is placed on the clipboard as PNG and
 * the agent gets a Ctrl+V, so it ingests the image as if pasted. See
 * `docs/plans/terminal-file-drop.md`.
 */
export function useTerminalFileDrop(): void {
	useEffect(() => {
		// No OS drag-drop events in the web demo.
		if (isDemoMode()) return;

		let unlisten: (() => void) | undefined;
		let disposed = false;

		getCurrentWebview()
			.onDragDropEvent((event) => {
				const p = event.payload;
				if (p.type === "over") {
					useFileDropStore
						.getState()
						.setHoverPane(paneIdAtPoint(p.position.x, p.position.y));
				} else if (p.type === "leave") {
					useFileDropStore.getState().setHoverPane(null);
				} else if (p.type === "drop") {
					useFileDropStore.getState().setHoverPane(null);
					void handleDrop(p.paths, p.position.x, p.position.y);
				}
			})
			.then((fn) => {
				if (disposed) fn();
				else unlisten = fn;
			})
			.catch(() => {});

		return () => {
			disposed = true;
			useFileDropStore.getState().setHoverPane(null);
			unlisten?.();
		};
	}, []);
}

async function handleDrop(
	paths: string[],
	physX: number,
	physY: number,
): Promise<void> {
	if (!paths || paths.length === 0) return;

	const paneId = paneIdAtPoint(physX, physY);
	if (!paneId) return; // dropped outside a terminal pane → ignore

	const managed = getTerminal(paneId);
	const ptyId = managed?.ptyId;
	if (!managed || !ptyId) return;

	// Focus the target pane so subsequent typing lands where the file did.
	useWorkspaceStore.getState().setFocusedPane(paneId);

	// Gate on `detectionMode` — the same canonical agent/shell signal TerminalSlot
	// and the status indicators read — so this never diverges from the rest of
	// the UI. (agentPtyIds is kept in lockstep with it by setAgentPty/clearAgentPty,
	// but detectionMode is the one source of truth.)
	const isAgent =
		usePtyActivityStore.getState().activities[ptyId]?.detectionMode === "agent";
	const mode: DropMode = isAgent ? "agent" : "shell";

	// Smart image drop: single image onto an agent, setting on → clipboard + Ctrl+V.
	if (
		isAgent &&
		useSettingsStore.getState().smartImageDrop &&
		paths.length === 1 &&
		isImagePath(paths[0])
	) {
		try {
			await clipboardImage.setFromPath(paths[0]);
			pty.write(ptyId, CTRL_V);
			return;
		} catch (err) {
			// Decode/clipboard failure → fall through to a path insert so the drop
			// still does something useful. Leave a breadcrumb: a silent fallback is
			// indistinguishable from "the setting is off" for a bug reporter.
			console.warn(
				"[fileDrop] clipboard image trick failed, inserting path instead:",
				err,
			);
		}
	}

	// Base behaviour: bracketed-paste the path(s) — never executed.
	managed.term.paste(buildDropText(paths, mode));
}
