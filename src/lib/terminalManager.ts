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
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { sendNotification } from "@tauri-apps/plugin-notification";
import type { PaneNode } from "./types";

function containsPaneId(node: PaneNode, targetPaneId: string): boolean {
	if (node.type === "terminal") return node.id === targetPaneId;
	return containsPaneId(node.first, targetPaneId) || containsPaneId(node.second, targetPaneId);
}

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
	/** True while replaying saved scrollback — suppresses forwarding xterm query responses to the PTY */
	restoring: boolean;
	/** True until the terminal receives its first focus — suppresses activity tracking during shell startup */
	suppressActivity: boolean;
	/** True while the terminal has keyboard focus — keeps dot in idle (green) state */
	focused: boolean;
	/** Timestamp of last user input — used to suppress activity tracking for echoed characters */
	lastInputAt: number;
	/** Accumulated output bytes since last idle — used to filter out small outputs like prompt redraws */
	bytesSinceIdle: number;
}

const instances = new Map<string, ManagedTerminal>();

// Background activity listeners for PTYs whose terminals have been destroyed (session switch)
// These keep tracking activity so session/tab dots update for inactive sessions
const backgroundTrackers = new Map<string, { unlistenOutput: () => void; unlistenStatus: () => void }>();

const ACTIVITY_BYTE_THRESHOLD = 512;

async function startBackgroundTracking(ptyId: string) {
	if (backgroundTrackers.has(ptyId)) return;
	let bgBytesSinceIdle = 0;
	const unlistenOutput = await pty.onOutput(ptyId, (data) => {
		bgBytesSinceIdle += data.length;
		if (bgBytesSinceIdle >= ACTIVITY_BYTE_THRESHOLD) {
			bgBytesSinceIdle = 0;
			usePtyActivityStore.getState().recordOutput(ptyId);
		}
	});
	const unlistenStatus = await pty.onStatus(ptyId, (status) => {
		useSessionStore.getState().setPtyStatus(ptyId, status);
		if (status.type === "exited" && status.code !== 0 && status.code !== null) {
			usePtyActivityStore.getState().recordError(ptyId);
		}
	});
	backgroundTrackers.set(ptyId, { unlistenOutput, unlistenStatus });
}

function stopBackgroundTracking(ptyId: string) {
	const tracker = backgroundTrackers.get(ptyId);
	if (tracker) {
		tracker.unlistenOutput();
		tracker.unlistenStatus();
		backgroundTrackers.delete(ptyId);
	}
}

// Deferred subscription — runs after all modules are initialized
setTimeout(() => {
	useSessionStore.subscribe((state) => {
		const { activeSessionId, activeView, focusedPaneId } = state;
		if (!activeSessionId) return;
		const view = activeView[activeSessionId] ?? "terminal";
		const isTerminalView = view === "terminal";

		const activityStore = usePtyActivityStore.getState();
		for (const [paneId, managed] of instances) {
			managed.focused = isTerminalView && focusedPaneId === paneId;
			if (managed.focused) {
				managed.suppressActivity = false;
				if (managed.ptyId) {
					activityStore.markIdle(managed.ptyId);
				}
			}
			// Ensure all terminals in the active session have an activity entry (grey → green)
			if (managed.ptyId) {
				activityStore.initPty(managed.ptyId);
			}
		}
	});
}, 0);

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
		restoring: false,
		suppressActivity: true,
		focused: false,
		lastInputAt: 0,
		bytesSinceIdle: 0,
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
			managed.restoring = true;
			term.write(restoreData, () => {
				managed.restoring = false;
			});
		} else {
			managed.pendingRestore = restoreData;
		}
	}

	if (!currentPtyId) {
		currentPtyId = await pty.spawn(cwd, term.cols, term.rows, undefined, paneId);
		managed.ptyId = currentPtyId;

		// Write ptyId to the correct tab's layout (not just the active tab)
		const store = useSessionStore.getState();
		const session = store.getActiveSession();
		if (session) {
			for (const tab of session.tabs) {
				try {
					const layout = JSON.parse(tab.layoutJson) as PaneNode;
					if (containsPaneId(layout, paneId)) {
						const updated = setPtyIdInLayout(layout, paneId, currentPtyId);
						store.updateLayoutLocal(tab.id, updated);
						break;
					}
				} catch {
					// skip
				}
			}
		}
	}

	// Stop background tracker if one exists — full listener takes over
	stopBackgroundTracking(currentPtyId);

	setPtyStatus(currentPtyId, { type: "running" });
	const actStore = usePtyActivityStore.getState();
	actStore.initPty(currentPtyId);
	actStore.registerPane(paneId, currentPtyId);

	term.onData((data) => {
		if (managed.restoring) return;
		managed.lastInputAt = Date.now();
		managed.bytesSinceIdle = 0;
		usePtyActivityStore.getState().markIdle(currentPtyId);
		pty.write(currentPtyId, data);
	});

	const INPUT_ECHO_MS = 100;

	const unlistenOutput = await pty.onOutput(currentPtyId, (data) => {
		term.write(data);
		if (!managed.suppressActivity && Date.now() - managed.lastInputAt > INPUT_ECHO_MS) {
			managed.bytesSinceIdle += data.length;
			if (managed.bytesSinceIdle >= ACTIVITY_BYTE_THRESHOLD) {
				managed.bytesSinceIdle = 0;
				usePtyActivityStore.getState().recordOutput(currentPtyId);
			}
		}
	});

	const unlistenStatus = await pty.onStatus(currentPtyId, (status) => {
		useSessionStore.getState().setPtyStatus(currentPtyId, status);
		if (status.type === "exited") {
			if (status.code !== 0 && status.code !== null) {
				usePtyActivityStore.getState().recordError(currentPtyId);
			}
			const exitMsg = status.code === 0 ? "exited" : `exited with code ${status.code}`;
			try {
				sendNotification({ title: "Abundio", body: `Process ${exitMsg}` });
			} catch {
				// Notifications may not be permitted
			}
		}
	});

	term.onTitleChange((title) => {
		usePtyActivityStore.getState().setTitle(paneId, title);
	});

	// Clicking an already-focused terminal should clear "waiting" → "idle"
	const onTermClick = () => {
		if (managed.ptyId) {
			usePtyActivityStore.getState().markIdle(managed.ptyId);
		}
	};
	term.element?.addEventListener("mousedown", onTermClick);

	registerSnapshot(paneId, () => serializeAddon.serialize());

	managed.cleanup = () => {
		unregisterSnapshot(paneId);
		unlistenOutput();
		unlistenStatus();
		term.element?.removeEventListener("mousedown", onTermClick);
	};
}

/** Write any deferred scrollback restore data now that the terminal has real dimensions */
export function flushPendingRestore(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed || !managed.pendingRestore) return;
	managed.restoring = true;
	managed.term.write(managed.pendingRestore, () => {
		managed.restoring = false;
	});
	managed.pendingRestore = null;
}

/** Update theme on all terminal instances */
export function setAllTerminalsTheme(theme: ITheme): void {
	for (const managed of instances.values()) {
		managed.term.options.theme = theme;
	}
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
	// Start background tracking so activity dots update for inactive sessions
	if (managed.ptyId) {
		startBackgroundTracking(managed.ptyId);
	}
}
