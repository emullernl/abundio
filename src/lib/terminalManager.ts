import { sendNotification } from "@tauri-apps/plugin-notification";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import {
	setFocusedPaneIdGetter,
	setShellCommandRunning,
	touchLastOutput,
	usePtyActivityStore,
} from "../stores/ptyActivityStore";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { matchProcessToAgent } from "./agents";
import { pty } from "./ipc";
import { parseShellIntegration } from "./shellIntegration";
import { registerSnapshot, unregisterSnapshot } from "./snapshotRegistry";
import { stripResetSequences } from "./terminalResetFilter";
import type { PaneNode } from "./types";

function containsPaneId(node: PaneNode, targetPaneId: string): boolean {
	if (node.type === "terminal") return node.id === targetPaneId;
	return (
		containsPaneId(node.first, targetPaneId) ||
		containsPaneId(node.second, targetPaneId)
	);
}

function setPtyIdInLayout(
	node: PaneNode,
	targetPaneId: string,
	ptyId: string,
): PaneNode {
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
	/** Timestamp of last output chunk — used to reset accumulation after inactivity gap */
	lastOutputChunkAt: number;
	/** True once initPty has completed — used by TerminalLoader to hide the spinner */
	ready: boolean;
	/** True once the terminal has been projected, fit, and painted — loader waits for this */
	settled: boolean;
	/** Buffers PTY output during shell startup so reset sequences can be stripped from the
	 *  complete buffer before writing. Null when the grace period has ended. */
	startupBuffer: Uint8Array[] | null;
	/** True once the shell's first precmd/command_end has fired — shell init is complete */
	startupShellReady: boolean;
}

const instances = new Map<string, ManagedTerminal>();

// Background activity listeners for PTYs whose terminals have been destroyed (session switch)
// These keep tracking activity so session/tab dots update for inactive sessions
const backgroundTrackers = new Map<
	string,
	{ unlistenOutput: () => void; unlistenStatus: () => void }
>();

let ACTIVITY_BYTE_THRESHOLD = 512;

export function getActivityByteThreshold(): number {
	return ACTIVITY_BYTE_THRESHOLD;
}

export function setActivityByteThreshold(n: number): void {
	ACTIVITY_BYTE_THRESHOLD = Math.max(1, Math.round(n));
}
// Output is ignored for INPUT_GATE_MS after the last keystroke to suppress
// echoed characters and prompt redraws. If no output arrives for
// INACTIVITY_RESET_MS the byte counter resets, filtering out slow trickle
// noise (cursor blinks, periodic status output) that never builds into
// sustained activity.
export const INPUT_GATE_MS = 2000;
export const INACTIVITY_RESET_MS = 3000;

async function startBackgroundTracking(ptyId: string) {
	if (backgroundTrackers.has(ptyId)) return;
	let bgBytesSinceIdle = 0;
	let bgLastOutputChunkAt = 0;
	const unlistenOutput = await pty.onOutput(ptyId, (data) => {
		// Only run byte accumulation for agent-mode PTYs
		const entry = usePtyActivityStore.getState().activities[ptyId];
		if (entry?.detectionMode !== "agent") return;
		const now = Date.now();
		if (
			bgLastOutputChunkAt &&
			now - bgLastOutputChunkAt > INACTIVITY_RESET_MS
		) {
			bgBytesSinceIdle = 0;
		}
		bgLastOutputChunkAt = now;
		bgBytesSinceIdle += data.length;

		if (entry?.state === "active") {
			touchLastOutput(ptyId, now);
		} else if (bgBytesSinceIdle >= ACTIVITY_BYTE_THRESHOLD) {
			bgBytesSinceIdle = 0;
			usePtyActivityStore.getState().recordOutput(ptyId);
		}
	});
	const unlistenStatus = await pty.onStatus(ptyId, (status) => {
		if (status.type === "exited") {
			const actStore = usePtyActivityStore.getState();
			if (status.code !== 0 && status.code !== null) {
				actStore.recordError(ptyId);
			} else {
				actStore.recordExitSuccess(ptyId);
			}
		}
		useSessionStore.getState().setPtyStatus(ptyId, status);
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
	setFocusedPaneIdGetter(() => useSessionStore.getState().focusedPaneId);
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
	// Ensure all font variants are loaded before xterm rasterizes glyphs into its texture atlas.
	// Fonts are eagerly preloaded in main.tsx; this is a fast synchronous check with async fallback.
	const fontSpec = `${options.fontSize}px ${options.fontFamily}`;
	if (!document.fonts.check(fontSpec)) {
		try {
			await Promise.all([
				document.fonts.load(fontSpec),
				document.fonts.load(`bold ${fontSpec}`),
				document.fonts.load(`italic ${fontSpec}`),
			]);
		} catch {
			// Proceed with fallback if font loading fails
		}
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

	const loadWebgl = (retries = 3) => {
		if (retries <= 0) return;
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => {
				webgl.dispose();
				requestAnimationFrame(() => loadWebgl(retries - 1));
			});
			term.loadAddon(webgl);
		} catch {
			// Canvas renderer fallback
		}
	};
	loadWebgl();

	if (container.offsetWidth > 0 && container.offsetHeight > 0) {
		fitAddon.fit();
	}

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
		lastOutputChunkAt: 0,
		ready: false,
		settled: false,
		startupBuffer: [],
		startupShellReady: false,
	};

	instances.set(paneId, managed);

	// Load scrollback BEFORE returning so it's available when projectInto
	// calls flushPendingRestore. initPty is fire-and-forget, so if we read
	// scrollback inside it, the data wouldn't be ready in time.
	await loadScrollback(paneId, managed);

	// Initialize PTY connection (listeners + spawn, fire-and-forget)
	initPty(paneId, managed, cwd);

	return managed;
}

/** Load scrollback from snapshot/log and store it on the managed terminal.
 *  Called from createTerminal (awaited) so data is ready before projectInto. */
async function loadScrollback(
	paneId: string,
	managed: ManagedTerminal,
): Promise<void> {
	const currentPtyId = managed.ptyId;

	// Fire both reads concurrently and pick the preferred source afterwards.
	// When reconnecting to a running PTY, prefer the log over the snapshot.
	let restoreData: string | Uint8Array | null = null;
	if (currentPtyId) {
		const [log, snapshot] = await Promise.all([
			pty.readLog(paneId),
			pty.readSnapshot(paneId),
		]);
		restoreData = log ?? snapshot;
	} else {
		const [snapshot, log] = await Promise.all([
			pty.readSnapshot(paneId),
			pty.readLog(paneId),
		]);
		restoreData = snapshot ?? log;
	}
	if (restoreData) {
		if (managed.term.cols > 1 && managed.term.rows > 1) {
			managed.restoring = true;
			managed.term.write(restoreData, () => {
				managed.restoring = false;
			});
		} else {
			managed.pendingRestore = restoreData;
		}
	}
}

async function initPty(paneId: string, managed: ManagedTerminal, cwd: string) {
	const { term, serializeAddon } = managed;
	let currentPtyId = managed.ptyId;
	const isNewPty = !currentPtyId;

	const { setPtyStatus } = useSessionStore.getState();

	// No grace period needed for reconnections — the shell has already started
	if (!isNewPty) {
		managed.startupBuffer = null;
		managed.startupShellReady = true;
	}

	// For new PTYs, generate the ID upfront and register event listeners BEFORE
	// spawning so no shell output is lost in the gap between spawn and listen.
	if (isNewPty) {
		currentPtyId = crypto.randomUUID();
		managed.ptyId = currentPtyId;
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
		const actStore = usePtyActivityStore.getState();
		actStore.clearError(currentPtyId);
		actStore.markIdle(currentPtyId);
		pty.write(currentPtyId, data);
	});

	// Register all event listeners and spawn PTY in parallel — each is an async
	// IPC round-trip, so running them concurrently cuts init time significantly.
	const [unlistenOutput, unlistenActivity, unlistenStatus] = await Promise.all([
		pty.onOutput(currentPtyId, (data) => {
			const entry = usePtyActivityStore.getState().activities[currentPtyId];
			if (entry?.detectionMode === "shell") {
				// Shell mode: parse and strip shell integration sequences, no output pipeline
				const { cleaned, commands } = parseShellIntegration(data);

				if (managed.startupBuffer) {
					// Buffer output during shell startup; flush when grace period ends
					managed.startupBuffer.push(cleaned);
				} else {
					term.write(cleaned);
				}

				if (managed.suppressActivity) return;
				for (const cmd of commands) {
					const actStore = usePtyActivityStore.getState();
					if (cmd.type === "command_start") {
						setShellCommandRunning(currentPtyId, true);
						actStore.recordOutput(currentPtyId);
					} else if (cmd.type === "command_end") {
						managed.startupShellReady = true;
						tryFlushStartup(managed);
						setShellCommandRunning(currentPtyId, false);
						if (cmd.exitCode !== undefined && cmd.exitCode !== 0) {
							actStore.recordError(currentPtyId);
						} else {
							const isFocused =
								document.hasFocus() &&
								useSessionStore.getState().focusedPaneId === paneId;
							if (isFocused) {
								actStore.markIdle(currentPtyId);
							} else {
								actStore.recordExitSuccess(currentPtyId);
							}
						}
					}
				}
			} else {
				// Agent mode: existing byte accumulation pipeline
				if (managed.startupBuffer) {
					managed.startupBuffer.push(data);
				} else {
					term.write(data);
				}
				if (
					!managed.suppressActivity &&
					Date.now() - managed.lastInputAt > INPUT_GATE_MS
				) {
					const now = Date.now();
					if (
						managed.lastOutputChunkAt &&
						now - managed.lastOutputChunkAt > INACTIVITY_RESET_MS
					) {
						managed.bytesSinceIdle = 0;
					}
					managed.lastOutputChunkAt = now;
					managed.bytesSinceIdle += data.length;

					const entry = usePtyActivityStore.getState().activities[currentPtyId];
					if (entry?.state === "active") {
						// Keep-alive: any output keeps active state alive without
						// needing to re-accumulate the full byte threshold.
						touchLastOutput(currentPtyId, now);
					} else if (managed.bytesSinceIdle >= ACTIVITY_BYTE_THRESHOLD) {
						managed.bytesSinceIdle = 0;
						usePtyActivityStore.getState().recordOutput(currentPtyId);
					}
				}
			}
		}),

		pty.onActivity(currentPtyId, (activity) => {
			const actStore = usePtyActivityStore.getState();

			// Agent detection via foreground process — always processed,
			// even when suppressActivity is true (mode detection, not activity).
			if (activity.type === "foregroundProcess") {
				const agents = useSettingsStore.getState().agents;
				if (matchProcessToAgent(activity.name, agents)) {
					actStore.setAgentPty(currentPtyId);
				}
				return;
			}
			if (activity.type === "foregroundProcessExited") {
				actStore.clearAgentPty(currentPtyId);
				return;
			}

			if (managed.suppressActivity) return;

			// Shell command tracking — only applies in shell mode
			const entry = actStore.activities[currentPtyId];
			if (entry?.detectionMode !== "shell") return;
			if (activity.type === "commandStarted") {
				setShellCommandRunning(currentPtyId, true);
				actStore.recordOutput(currentPtyId);
			} else if (activity.type === "commandFinished") {
				setShellCommandRunning(currentPtyId, false);
				if (entry.state === "active") {
					const isFocused =
						document.hasFocus() &&
						useSessionStore.getState().focusedPaneId === paneId;
					if (isFocused) {
						actStore.markIdle(currentPtyId);
					} else {
						actStore.recordExitSuccess(currentPtyId);
					}
				}
			}
		}),

		pty.onStatus(currentPtyId, (status) => {
			if (status.type === "exited") {
				// Set activity state BEFORE setPtyStatus to avoid subscriber race
				const actStore = usePtyActivityStore.getState();
				if (status.code !== 0 && status.code !== null) {
					actStore.recordError(currentPtyId);
				} else {
					actStore.recordExitSuccess(currentPtyId);
				}
			}
			useSessionStore.getState().setPtyStatus(currentPtyId, status);
			if (status.type === "exited") {
				const exitMsg =
					status.code === 0 ? "exited" : `exited with code ${status.code}`;
				try {
					sendNotification({ title: "Abundio", body: `Process ${exitMsg}` });
				} catch {
					// Notifications may not be permitted
				}
			}
		}),

		// Spawn PTY concurrently with listener registration — listeners use
		// event names that include the ptyId, so they won't miss output even
		// if spawn completes first (Tauri buffers events until listen resolves).
		...(isNewPty
			? [pty.spawn(cwd, term.cols, term.rows, undefined, paneId, currentPtyId)]
			: []),
	]);

	// Safety timeout: flush the startup buffer even if shell integration
	// hooks never fire (e.g. custom shell without integration support).
	if (isNewPty) {
		setTimeout(() => {
			flushStartupBuffer(managed);
		}, 3000);
	}

	if (isNewPty) {
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

	term.onTitleChange((title) => {
		const actStore = usePtyActivityStore.getState();
		actStore.setTitle(paneId, title);
	});

	// A click in an already-focused terminal (e.g. scrolling without typing) should
	// clear "waiting" → "idle". Focus-changes and keystrokes are handled elsewhere.
	const onTermClick = () => {
		if (managed.ptyId) {
			const actStore = usePtyActivityStore.getState();
			actStore.clearError(managed.ptyId);
			actStore.markIdle(managed.ptyId);
		}
	};
	if (term.element) {
		term.element.addEventListener("mousedown", onTermClick);
	} else {
		// term.open() hasn't been called yet; log so this is visible during development
		console.warn(
			"[terminalManager] term.element is null in initPty — mousedown idle-clear not registered for",
			paneId,
		);
	}

	registerSnapshot(paneId, () => serializeAddon.serialize());

	managed.cleanup = () => {
		unregisterSnapshot(paneId);
		unlistenOutput();
		unlistenActivity();
		unlistenStatus();
		term.element?.removeEventListener("mousedown", onTermClick);
	};

	managed.ready = true;
}

/** Try to flush the startup buffer. Only flushes once BOTH the terminal is
 *  settled (projected + scrollback written) AND the shell has finished
 *  initializing (command_end received). Adds a short delay to also capture
 *  the shell's resize-triggered redraw that follows projectInto's PTY resize. */
function tryFlushStartup(managed: ManagedTerminal): void {
	if (!managed.startupBuffer) return; // already flushed
	if (!managed.settled || !managed.startupShellReady) return; // not ready yet
	setTimeout(() => flushStartupBuffer(managed), 200);
}

/** Flush the startup output buffer: concatenate all chunks, strip terminal
 *  reset/clear/home sequences, then write the cleaned result to the terminal. */
function flushStartupBuffer(managed: ManagedTerminal): void {
	const chunks = managed.startupBuffer;
	if (!chunks) return;
	managed.startupBuffer = null;

	if (chunks.length === 0) return;

	// Concatenate all buffered chunks into a single Uint8Array
	let totalLen = 0;
	for (const chunk of chunks) totalLen += chunk.length;
	const combined = new Uint8Array(totalLen);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}

	const cleaned = stripResetSequences(combined);
	if (cleaned.length > 0) {
		managed.term.write(cleaned);
	}
}

/** Mark terminal as visually settled — loader can now hide */
export function markSettled(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	managed.settled = true;
	tryFlushStartup(managed);
}

/** Write any deferred scrollback restore data now that the terminal has real dimensions */
export function flushPendingRestore(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed?.pendingRestore) return;
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
		managed.term.refresh(0, managed.term.rows - 1);
	}
}

/** Update font size on all terminal instances and refit */
export function setAllTerminalsFontSize(fontSize: number): void {
	for (const managed of instances.values()) {
		managed.term.options.fontSize = fontSize;
		managed.fitAddon.fit();
		if (managed.ptyId) {
			pty
				.resize(managed.ptyId, managed.term.cols, managed.term.rows)
				.catch(() => {});
		}
	}
}

/** Update font family on all terminal instances and refit */
export async function setAllTerminalsFontFamily(
	fontFamily: string,
): Promise<void> {
	const fontSize = instances.values().next().value?.term.options.fontSize ?? 14;
	try {
		await Promise.all([
			document.fonts.load(`${fontSize}px ${fontFamily}`),
			document.fonts.load(`bold ${fontSize}px ${fontFamily}`),
			document.fonts.load(`italic ${fontSize}px ${fontFamily}`),
		]);
	} catch {
		// Proceed with fallback if font loading fails
	}

	for (const managed of instances.values()) {
		managed.term.options.fontFamily = fontFamily;
		managed.term.refresh(0, managed.term.rows - 1);
		managed.fitAddon.fit();
		if (managed.ptyId) {
			pty
				.resize(managed.ptyId, managed.term.cols, managed.term.rows)
				.catch(() => {});
		}
	}
}

/** Reset a terminal: kill the current PTY and spawn a fresh one */
export async function resetTerminal(paneId: string): Promise<void> {
	const managed = instances.get(paneId);
	if (!managed) return;

	const oldPtyId = managed.ptyId;

	// Clean up old PTY listeners
	managed.cleanup?.();
	managed.cleanup = null;

	// Kill the old PTY
	if (oldPtyId) {
		pty.kill(oldPtyId).catch(() => {});
		usePtyActivityStore.getState().removePty(oldPtyId);
		usePtyActivityStore.getState().removePane(paneId);
	}

	// Reset xterm content
	managed.term.reset();
	managed.ptyId = "";
	managed.ready = false;
	managed.suppressActivity = true;
	managed.lastInputAt = 0;
	managed.bytesSinceIdle = 0;
	managed.lastOutputChunkAt = 0;
	managed.pendingRestore = null;
	managed.restoring = false;

	// Get cwd from the active session
	const session = useSessionStore.getState().getActiveSession();
	const cwd = session?.rootFolder ?? ".";

	// Re-initialize PTY (spawns a new shell)
	await initPty(paneId, managed, cwd);
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
