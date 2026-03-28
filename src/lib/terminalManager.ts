import { Terminal, type ITheme } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
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
	/** Deferred scrollback data to write after terminal is projected into a visible container */
	pendingRestore: string | Uint8Array | null;
}

const instances = new Map<string, ManagedTerminal>();

export function getTerminal(paneId: string): ManagedTerminal | undefined {
	return instances.get(paneId);
}

export async function createTerminal(
	paneId: string,
	initialPtyId: string,
	cwd: string,
	container: HTMLElement,
	options: { fontSize: number; fontFamily: string; theme: ITheme },
): Promise<ManagedTerminal> {
	// Ensure all font variants are loaded before xterm rasterizes glyphs into its texture atlas
	try {
		await Promise.all([
			document.fonts.load(`${options.fontSize}px ${options.fontFamily}`),
			document.fonts.load(`bold ${options.fontSize}px ${options.fontFamily}`),
			document.fonts.load(`italic ${options.fontSize}px ${options.fontFamily}`),
		]);
	} catch {
		// Proceed with fallback if font loading fails
	}

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
	const unicode11 = new Unicode11Addon();
	term.loadAddon(unicode11);
	term.unicode.activeVersion = "11";
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
		pendingRestore: null,
	};

	instances.set(paneId, managed);

	// Initialize PTY connection (scrollback is deferred until projectInto)
	initPty(paneId, managed, cwd);

	return managed;
}

async function initPty(paneId: string, managed: ManagedTerminal, cwd: string) {
	const { term, serializeAddon } = managed;
	let currentPtyId = managed.ptyId;

	const { setPtyStatus } = useSessionStore.getState();

	// Load scrollback but defer writing until terminal is projected into a visible container
	// (writing into a 0x0 hidden container would wrap content at ~2 columns)
	// When reconnecting to a running PTY, prefer the log over the snapshot — the log
	// includes output produced while the UI was torn down, while the snapshot is stale.
	let restoreData: string | Uint8Array | null = null;
	if (currentPtyId) {
		restoreData = (await pty.readLog(paneId)) ?? (await pty.readSnapshot(paneId));
	} else {
		const snapshot = await pty.readSnapshot(paneId);
		restoreData = snapshot ?? (await pty.readLog(paneId));
	}
	if (restoreData) {
		// If terminal is already projected (has real dimensions), write immediately;
		// otherwise store for flushPendingRestore() to handle after projection
		if (term.cols > 1 && term.rows > 1) {
			term.write(restoreData);
		} else {
			managed.pendingRestore = restoreData;
		}
	}

	if (!currentPtyId) {
		currentPtyId = await pty.spawn(cwd, term.cols, term.rows, undefined, paneId);
		managed.ptyId = currentPtyId;

		const store = useSessionStore.getState();
		const tab = store.getActiveTab();
		const layout = store.getActiveLayout();
		if (tab && layout) {
			const updated = setPtyIdInLayout(layout, paneId, currentPtyId);
			store.updateLayoutLocal(tab.id, updated);
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

/** Write any deferred scrollback restore data now that the terminal has real dimensions */
export function flushPendingRestore(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed || !managed.pendingRestore) return;
	managed.term.write(managed.pendingRestore);
	managed.pendingRestore = null;
}

/** Update font size on all terminal instances and refit */
export function setAllTerminalsFontSize(fontSize: number): void {
	for (const managed of instances.values()) {
		managed.term.options.fontSize = fontSize;
		managed.fitAddon.fit();
		if (managed.ptyId) {
			pty.resize(managed.ptyId, managed.term.cols, managed.term.rows).catch(() => {});
		}
	}
}

/** Fully destroy a terminal (used when closing a pane) */
export function destroyTerminal(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	// Serialize scrollback before cleanup/dispose destroys the terminal
	try {
		const data = managed.serializeAddon.serialize();
		if (data) {
			pty.writeSnapshot(paneId, data);
		}
	} catch {
		// Terminal may be in intermediate state
	}
	managed.cleanup?.();
	managed.term.dispose();
	instances.delete(paneId);
}
