import { Terminal, type ITheme } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { pty } from "./ipc";
import { registerSnapshot, unregisterSnapshot } from "./snapshotRegistry";
import { useSessionStore } from "../stores/sessionStore";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type { PaneNode } from "./types";

function setPtyIdInLayout(node: PaneNode, targetPaneId: string, ptyId: string): PaneNode {
	if (node.type === "terminal") {
		return node.id === targetPaneId ? { ...node, ptyId } : node;
	}
	return {
		...node,
		first: setPtyIdInLayout(node.first, targetPaneId, ptyId),
		second: setPtyIdInLayout(node.second, targetPaneId, ptyId),
	};
}

export interface ManagedTerminal {
	term: Terminal;
	fitAddon: FitAddon;
	searchAddon: SearchAddon;
	serializeAddon: SerializeAddon;
	ptyId: string;
	cleanup: (() => void) | null;
}

/** Hidden container to hold detached terminal DOMs so they aren't garbage collected */
const offscreen = document.createElement("div");
offscreen.style.position = "fixed";
offscreen.style.left = "-9999px";
offscreen.style.visibility = "hidden";
document.body.appendChild(offscreen);

const instances = new Map<string, ManagedTerminal>();

export function getTerminal(paneId: string): ManagedTerminal | undefined {
	return instances.get(paneId);
}

export function createTerminal(
	paneId: string,
	initialPtyId: string,
	cwd: string,
	container: HTMLElement,
	options: { fontSize: number; fontFamily: string; theme: ITheme },
): ManagedTerminal {
	const term = new Terminal({
		fontSize: options.fontSize,
		fontFamily: options.fontFamily,
		cursorBlink: true,
		allowProposedApi: true,
		theme: options.theme,
	});

	const fitAddon = new FitAddon();
	const searchAddon = new SearchAddon();
	const serializeAddon = new SerializeAddon();
	term.loadAddon(fitAddon);
	term.loadAddon(searchAddon);
	term.loadAddon(serializeAddon);
	term.loadAddon(new WebLinksAddon());
	term.open(container);

	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => webgl.dispose());
		term.loadAddon(webgl);
	} catch {
		// Canvas renderer fallback
	}

	fitAddon.fit();

	const managed: ManagedTerminal = {
		term,
		fitAddon,
		searchAddon,
		serializeAddon,
		ptyId: initialPtyId,
		cleanup: null,
	};

	instances.set(paneId, managed);

	// Initialize PTY connection
	initPty(paneId, managed, cwd);

	return managed;
}

async function initPty(paneId: string, managed: ManagedTerminal, cwd: string) {
	const { term, serializeAddon } = managed;
	let currentPtyId = managed.ptyId;

	const { setPtyStatus } = useSessionStore.getState();

	if (!currentPtyId) {
		// Restore scrollback: prefer snapshot over raw log
		const snapshot = await pty.readSnapshot(paneId);
		if (snapshot) {
			term.write(snapshot);
		} else {
			const logData = await pty.readLog(paneId);
			if (logData) {
				term.write(logData);
			}
		}

		currentPtyId = await pty.spawn(cwd, term.cols, term.rows, undefined, paneId);
		managed.ptyId = currentPtyId;

		const store = useSessionStore.getState();
		const session = store.getActiveSession();
		const layout = store.getActiveLayout();
		if (session && layout) {
			const updated = setPtyIdInLayout(layout, paneId, currentPtyId);
			store.updateLayoutLocal(session.id, updated);
		}
	}

	setPtyStatus(currentPtyId, { type: "running" });

	term.onData((data) => {
		pty.write(currentPtyId, data);
	});

	const unlistenOutput = await pty.onOutput(currentPtyId, (data) => {
		term.write(data);
	});

	const unlistenStatus = await pty.onStatus(currentPtyId, (status) => {
		useSessionStore.getState().setPtyStatus(currentPtyId, status);
		if (status.type === "exited") {
			const exitMsg = status.code === 0 ? "exited" : `exited with code ${status.code}`;
			try {
				sendNotification({ title: "Abundio", body: `Process ${exitMsg}` });
			} catch {
				// Notifications may not be permitted
			}
		}
	});

	registerSnapshot(paneId, () => serializeAddon.serialize());

	managed.cleanup = () => {
		unregisterSnapshot(paneId);
		unlistenOutput();
		unlistenStatus();
	};
}

/** Move a terminal's DOM into a new container and refit */
export function attachTerminal(paneId: string, container: HTMLElement): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	const termEl = managed.term.element;
	if (termEl && termEl.parentElement !== container) {
		container.appendChild(termEl);
	}
	managed.fitAddon.fit();
	pty.resize(managed.ptyId, managed.term.cols, managed.term.rows).catch(() => {});
}

/** Detach a terminal's DOM to offscreen (keeps it alive) */
export function detachTerminal(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	const termEl = managed.term.element;
	if (termEl) {
		offscreen.appendChild(termEl);
	}
}

/** Fully destroy a terminal (used when closing a pane) */
export function destroyTerminal(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	managed.cleanup?.();
	managed.term.dispose();
	instances.delete(paneId);
}
