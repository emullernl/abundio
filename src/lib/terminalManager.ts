import { open } from "@tauri-apps/plugin-shell";
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
import { useSettingsStore } from "../stores/settingsStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { recordThresholdHit } from "./activityGate";
import { matchTitleToAgent } from "./agents";
import { pty } from "./ipc";
import { collectPaneIds } from "./paneTree";
import { takePendingAgent } from "./pendingAgentRegistry";
import { parseShellIntegration } from "./shellIntegration";
import { registerSnapshot, unregisterSnapshot } from "./snapshotRegistry";
import { stripResetSequences } from "./terminalResetFilter";
import type { PaneNode } from "./types";

/** CSS generic family keywords — these have no @font-face and must never be
 *  passed to FontFaceSet.load() / .check() as the family to await on. */
const CSS_GENERIC_FAMILIES =
	/^(monospace|serif|sans-serif|cursive|fantasy|system-ui|ui-monospace|ui-serif|ui-sans-serif|ui-rounded|emoji|math|fangsong)$/i;

/** Attempt to load the WebGL renderer addon on a managed terminal. Idempotent:
 *  if webglAddon is already set, this is a no-op. On failure, logs the error
 *  (previously swallowed) so we can see when the browser refuses to create a
 *  WebGL context — e.g. the per-page context limit (~16) or creation on a 0×0
 *  hidden canvas. On silent fall-through xterm keeps its DOM renderer, which
 *  has different glyph metrics and looks like the wrong font. */
function tryLoadWebgl(managed: ManagedTerminal, retries = 3): void {
	if (managed.webglAddon || retries <= 0) return;
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => {
			webgl.dispose();
			managed.webglAddon = null;
			requestAnimationFrame(() => tryLoadWebgl(managed, retries - 1));
		});
		managed.term.loadAddon(webgl);
		managed.webglAddon = webgl;
	} catch (err) {
		console.warn(
			"[abundio] WebGL renderer failed to load; xterm will fall back to DOM renderer (glyph metrics will look off).",
			err,
		);
	}
}

/** Ensure the WebGL renderer is loaded on a terminal. Called from projectInto
 *  once the container is visible and sized — the first attempt in createTerminal
 *  runs while the canvas is still 0×0 and offscreen, which some browsers refuse.
 *
 *  Bails out for panes that aren't in the currently active tab: WebGL contexts
 *  are capped per page (~16 in Chromium), so we only ever hold contexts for
 *  panes the user is actually looking at. The store subscription below
 *  reattaches WebGL on tab/workspace switch. */
export function ensureWebglLoaded(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed || managed.webglAddon) return;
	if (!isPaneInActiveTab(paneId)) return;
	tryLoadWebgl(managed);
}

/** Dispose this pane's WebGL addon and free its GPU context. The terminal,
 *  PTY, and scrollback all keep running — only the GPU canvas is detached.
 *  A later ensureWebglLoaded() call will recreate it. */
export function unloadWebgl(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed?.webglAddon) return;
	managed.webglAddon.dispose();
	managed.webglAddon = null;
}

/** Returns true if `paneId` belongs to the active tab of the active workspace. */
function isPaneInActiveTab(paneId: string): boolean {
	const state = useWorkspaceStore.getState();
	const workspaceId = state.activeWorkspaceId;
	if (!workspaceId) return false;
	const tabId = state.activeTabByWorkspace[workspaceId];
	if (!tabId) return false;
	const workspace = state.workspaces.find((s) => s.id === workspaceId);
	const tab = workspace?.tabs.find((t) => t.id === tabId);
	if (!tab) return false;
	try {
		const layout = JSON.parse(tab.layoutJson) as PaneNode;
		return collectPaneIds(layout).includes(paneId);
	} catch {
		return false;
	}
}

/** Strip the comma-separated fallback list and any quotes from a CSS font-family
 *  value, returning the primary family name. e.g.
 *    "'Hack Nerd Font Mono', monospace" → "Hack Nerd Font Mono"
 *  Returns null if the primary family is a CSS generic (which has no @font-face)
 *  or if the value is empty. */
export function primaryFontFamily(fontFamily: string): string | null {
	const first = fontFamily
		.split(",")[0]
		?.trim()
		.replace(/^['"]|['"]$/g, "");
	if (!first) return null;
	if (CSS_GENERIC_FAMILIES.test(first)) return null;
	return first;
}

function containsPaneId(node: PaneNode, targetPaneId: string): boolean {
	if (node.type !== "split") return node.id === targetPaneId;
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
	if (node.type !== "split") return node;
	return {
		...node,
		first: setPtyIdInLayout(node.first, targetPaneId, ptyId),
		second: setPtyIdInLayout(node.second, targetPaneId, ptyId),
	};
}

export interface ManagedTerminal {
	paneId: string;
	term: Terminal;
	fitAddon: FitAddon;
	searchAddon: SearchAddon;
	serializeAddon: SerializeAddon;
	/** Active WebGL addon, if loaded — used to clear the texture atlas after
	 *  font/theme changes so glyphs are re-rasterized with the new settings. */
	webglAddon: WebglAddon | null;
	ptyId: string;
	cleanup: (() => void) | null;
	/** Scrollback data loaded from disk, waiting to be written. For new PTYs this
	 *  is written as the first chunk of flushStartupBuffer so it lands in xterm's
	 *  write queue before the shell's startup output — effectively "prepending"
	 *  scrollback above the live shell prompt without any race where shell reset
	 *  sequences could wipe restored content. For reconnections it's written
	 *  immediately after listeners are registered. */
	restoreData: string | Uint8Array | null;
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
	/** Timestamps of recent byte-threshold crossings — activity fires only after
	 *  ACTIVITY_HIT_COUNT crossings within ACTIVITY_HIT_WINDOW_MS, so a single
	 *  burst of output is no longer enough to flip the dot to active. */
	thresholdHitTimes: number[];
	/** Timestamp of last output chunk — used to reset accumulation after inactivity gap */
	lastOutputChunkAt: number;
	/** True once initPty has completed — used by TerminalLoader to hide the spinner */
	ready: boolean;
	/** True once the terminal has been projected, fit, and painted — loader waits for this */
	settled: boolean;
	/** Buffers PTY output during shell startup so reset sequences can be stripped from the
	 *  complete buffer before writing. Null when the grace period has ended. */
	startupBuffer: Uint8Array[] | null;
	/** Set to true once tryFlushStartup has scheduled its flush so re-entrant calls are ignored */
	startupFlushScheduled: boolean;
	/** When true, strip terminal reset sequences from PTY output inline (used during resize grace periods) */
	filterResets: boolean;
	/** Handle for the pending filterResets=false timer so consecutive calls to
	 *  beginResizeFilter can cancel the previous timer and properly extend the
	 *  window instead of clobbering it. */
	filterResetsTimer: ReturnType<typeof setTimeout> | null;
	/** True once the shell's first precmd/command_end has fired — shell init is complete */
	startupShellReady: boolean;
	/** Buffered output chunks waiting to be flushed to xterm in a single rAF write */
	pendingWrites: Uint8Array[];
	/** rAF handle for the pending write flush, or null if none scheduled */
	writeRafId: number | null;
	/** Deferred PTY init closure. Populated by createTerminal, consumed by the
	 *  first projectInto callback (via ensurePtySpawned). We spawn the PTY at
	 *  the real target dimensions rather than the xterm default 80×24 so the
	 *  shell never sees a size change — this avoids PSReadLine on Windows
	 *  emitting a resize-driven repaint whose absolute cursor positioning
	 *  lands the caret on the wrong row after restored scrollback is applied. */
	deferredInit: (() => void) | null;
}

const instances = new Map<string, ManagedTerminal>();

// Per-pane revision counters + listener set so React components can subscribe
// to "my pane's ManagedTerminal changed" without falling back to global
// store subscriptions. Bumped only at lifecycle transitions, never on output.
const paneRevisions = new Map<string, number>();
const paneListeners = new Map<string, Set<() => void>>();

export function getPaneRevision(paneId: string): number {
	return paneRevisions.get(paneId) ?? 0;
}

export function subscribePaneRevision(
	paneId: string,
	listener: () => void,
): () => void {
	let set = paneListeners.get(paneId);
	if (!set) {
		set = new Set();
		paneListeners.set(paneId, set);
	}
	set.add(listener);
	return () => {
		const s = paneListeners.get(paneId);
		if (!s) return;
		s.delete(listener);
		if (s.size === 0) paneListeners.delete(paneId);
	};
}

function bumpPaneRevision(paneId: string): void {
	paneRevisions.set(paneId, (paneRevisions.get(paneId) ?? 0) + 1);
	const set = paneListeners.get(paneId);
	if (!set) return;
	for (const l of set) l();
}

// Background activity listeners for PTYs whose terminals have been destroyed (workspace switch)
// These keep tracking activity so workspace/tab dots update for inactive workspaces
const backgroundTrackers = new Map<
	string,
	{ unlistenOutput: () => void; unlistenStatus: () => void }
>();

let ACTIVITY_BYTE_THRESHOLD = 1024;

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
	let bgThresholdHitTimes: number[] = [];
	let bgLastOutputChunkAt = 0;
	// Use onOutputRaw to skip base64 decode — background trackers only need
	// approximate byte counts for activity thresholds, not decoded content.
	const unlistenOutput = await pty.onOutputRaw(ptyId, (base64Data) => {
		// Only run byte accumulation for agent-mode PTYs
		const entry = usePtyActivityStore.getState().activities[ptyId];
		if (entry?.detectionMode !== "agent") return;
		const now = Date.now();
		if (
			bgLastOutputChunkAt &&
			now - bgLastOutputChunkAt > INACTIVITY_RESET_MS
		) {
			bgBytesSinceIdle = 0;
			// See foreground path: hit history is pruned by its own sliding
			// window, not by the byte-counter's inactivity gap.
		}
		bgLastOutputChunkAt = now;
		// Estimate decoded byte count from base64 string length
		bgBytesSinceIdle += Math.floor(base64Data.length * 0.75);

		if (entry?.state === "active") {
			touchLastOutput(ptyId, now);
		} else if (bgBytesSinceIdle >= ACTIVITY_BYTE_THRESHOLD) {
			bgBytesSinceIdle = 0;
			const result = recordThresholdHit(bgThresholdHitTimes, now);
			bgThresholdHitTimes = result.hitTimes;
			if (result.fire) {
				usePtyActivityStore.getState().recordOutput(ptyId);
			}
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
		useWorkspaceStore.getState().setPtyStatus(ptyId, status);
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

/** Queue a chunk for batched writing to xterm.js.  All chunks queued within
 *  one animation frame are concatenated and written in a single term.write()
 *  call, which xterm processes more efficiently than many small writes. */
function scheduleWrite(managed: ManagedTerminal, chunk: Uint8Array): void {
	managed.pendingWrites.push(chunk);
	if (managed.writeRafId === null) {
		managed.writeRafId = requestAnimationFrame(() => {
			flushWrites(managed);
		});
	}
}

function flushWrites(managed: ManagedTerminal): void {
	managed.writeRafId = null;
	const chunks = managed.pendingWrites;
	if (chunks.length === 0) return;
	if (chunks.length === 1) {
		managed.term.write(chunks[0]);
	} else {
		let total = 0;
		for (const c of chunks) total += c.length;
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			merged.set(c, offset);
			offset += c.length;
		}
		managed.term.write(merged);
	}
	managed.pendingWrites = [];
}

// Deferred subscription — runs after all modules are initialized.
// Guard against the case where the module context is torn down before the
// timer fires (e.g. in the Vitest jsdom environment after a test finishes).
setTimeout(() => {
	if (!useWorkspaceStore?.subscribe) return;
	setFocusedPaneIdGetter(() => useWorkspaceStore.getState().focusedPaneId);
	useWorkspaceStore.subscribe((state) => {
		const { activeWorkspaceId, focusedPaneId } = state;
		if (!activeWorkspaceId) return;

		// Compute the set of paneIds in the currently active tab so we can
		// keep WebGL contexts only for panes the user is actually looking at.
		// Browsers cap WebGL contexts at ~16 per page; without this gate, a
		// user with many tabs/workspaces hits "too many active WebGL contexts".
		const activeTabId = state.activeTabByWorkspace[activeWorkspaceId];
		const activeWorkspace = state.workspaces.find(
			(s) => s.id === activeWorkspaceId,
		);
		const activeTab = activeWorkspace?.tabs.find((t) => t.id === activeTabId);
		let activePaneIds: Set<string> | null = null;
		if (activeTab) {
			try {
				const layout = JSON.parse(activeTab.layoutJson) as PaneNode;
				activePaneIds = new Set(collectPaneIds(layout));
			} catch {
				activePaneIds = null;
			}
		}

		const activityStore = usePtyActivityStore.getState();
		for (const [paneId, managed] of instances) {
			managed.focused = focusedPaneId === paneId;
			managed.term.options.cursorBlink = managed.focused;
			if (managed.focused) {
				managed.suppressActivity = false;
				if (managed.ptyId) {
					activityStore.markIdle(managed.ptyId);
				}
			}
			// Ensure all terminals in the active workspace have an activity entry (grey → green)
			if (managed.ptyId) {
				activityStore.initPty(managed.ptyId);
			}
			// Reconcile WebGL: load for panes in the active tab, unload for the rest.
			if (activePaneIds?.has(paneId)) {
				ensureWebglLoaded(paneId);
			} else {
				unloadWebgl(paneId);
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
	options: {
		fontSize: number;
		fontFamily: string;
		theme: ITheme;
		scrollback: number;
	},
): Promise<ManagedTerminal> {
	// Ensure the configured font is loaded before xterm rasterizes glyphs into its
	// texture atlas. We must check the *primary* family in isolation: stored fontFamily
	// values look like "'Hack Nerd Font Mono', monospace", and FontFaceSet.check()
	// short-circuits to true the moment any family in the list is loadable — and
	// `monospace` is always loadable. Stripping the fallback restores the check.
	const primary = primaryFontFamily(options.fontFamily);
	if (primary) {
		const primarySpec = `${options.fontSize}px "${primary}"`;
		if (!document.fonts.check(primarySpec)) {
			try {
				await Promise.all([
					document.fonts.load(primarySpec),
					document.fonts.load(`bold ${primarySpec}`),
					document.fonts.load(`italic ${primarySpec}`),
				]);
			} catch {
				// Proceed with fallback if font loading fails
			}
		}
	}

	const term = new Terminal({
		fontSize: options.fontSize,
		fontFamily: options.fontFamily,
		scrollback: options.scrollback,
		cursorBlink: false,
		allowProposedApi: true,
		theme: options.theme,
	});

	const fitAddon = new FitAddon();
	const searchAddon = new SearchAddon();
	const serializeAddon = new SerializeAddon();
	term.loadAddon(fitAddon);
	term.loadAddon(searchAddon);
	term.loadAddon(serializeAddon);
	term.loadAddon(
		new WebLinksAddon((_event, url) => {
			open(url);
		}),
	);
	const unicode11 = new Unicode11Addon();
	term.loadAddon(unicode11);
	term.unicode.activeVersion = "11";
	term.open(container);

	if (container.offsetWidth > 0 && container.offsetHeight > 0) {
		fitAddon.fit();
	}

	const managed: ManagedTerminal = {
		paneId,
		term,
		fitAddon,
		searchAddon,
		serializeAddon,
		webglAddon: null,
		ptyId: initialPtyId,
		cleanup: null,
		restoreData: null,
		restoring: false,
		suppressActivity: true,
		focused: false,
		lastInputAt: 0,
		bytesSinceIdle: 0,
		thresholdHitTimes: [],
		lastOutputChunkAt: 0,
		ready: false,
		settled: false,
		filterResets: false,
		filterResetsTimer: null,
		startupBuffer: [],
		startupFlushScheduled: false,
		startupShellReady: false,
		pendingWrites: [],
		writeRafId: null,
		deferredInit: null,
	};

	// Populate deferredInit BEFORE publishing `managed` via instances.set so
	// any caller that looks it up (projectInto via onTargetChange, a racing
	// StrictMode remount, etc.) observes a consistent "not yet spawned"
	// state. If we set deferredInit after the `await loadScrollback` below,
	// there's a window where isPtySpawned() returns true (because
	// deferredInit is still null) but no PTY actually exists yet — and
	// projectInto's first callback would take the "already spawned" branch,
	// never call ensurePtySpawned, and leave the terminal with no listeners,
	// no input handler, and a permanently black canvas.
	managed.deferredInit = () => initPty(paneId, managed, cwd);

	instances.set(paneId, managed);
	bumpPaneRevision(paneId);

	// First attempt — may no-op because the pane isn't in the active tab yet,
	// or because the container is still hidden/0×0. projectInto() will retry
	// via ensureWebglLoaded() once the terminal is in a visible, sized
	// container, and the store subscription will retry on tab switch.
	ensureWebglLoaded(paneId);

	// Load scrollback so it's parked on managed before the PTY is eventually
	// spawned. flushStartupBuffer will emit it as the first chunk of write.
	await loadScrollback(paneId, managed);

	return managed;
}

/** Run the deferred PTY init (listener registration + spawn) if it hasn't
 *  run yet. Called from projectInto's first-callback path after fit() has
 *  computed the real grid dimensions. Idempotent. */
export function ensurePtySpawned(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	const init = managed.deferredInit;
	if (!init) return;
	managed.deferredInit = null;
	init();
}

/** True if the PTY has been spawned (or is in the process of being spawned)
 *  for this pane. projectInto uses this to decide whether to resize the PTY
 *  (spawned → resize to match fit) or just let ensurePtySpawned handle the
 *  initial sizing (not spawned → spawn at current fit dimensions). */
export function isPtySpawned(paneId: string): boolean {
	const managed = instances.get(paneId);
	if (!managed) return false;
	return managed.deferredInit === null;
}

/** Load scrollback from snapshot/log and park it on the managed terminal.
 *  Does NOT write into xterm — the write happens later, right before the
 *  buffered shell startup output is flushed (new PTY) or immediately after
 *  listener registration (reconnection). This ordering guarantees the shell
 *  cannot clobber restored scrollback with reset/clear sequences on startup. */
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
	managed.restoreData = restoreData;
}

/** Write any parked scrollback into xterm now, under the `restoring` guard so
 *  xterm query-response replies aren't echoed back to the PTY. Idempotent.
 *  Re-focuses the terminal after the write settles if the pane is the
 *  currently-focused pane — without this the cursor stays invisible because
 *  xterm's internal focus state was established before the scrollback write
 *  moved the cursor. */
function writeRestoreData(managed: ManagedTerminal): void {
	const data = managed.restoreData;
	if (!data) return;
	managed.restoreData = null;
	managed.restoring = true;
	managed.term.write(data, () => {
		managed.restoring = false;
		if (managed.focused) {
			managed.term.focus();
		}
	});
}

async function initPty(paneId: string, managed: ManagedTerminal, cwd: string) {
	const { term, serializeAddon } = managed;
	let currentPtyId = managed.ptyId;
	const isNewPty = !currentPtyId;

	const { setPtyStatus } = useWorkspaceStore.getState();

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
		bumpPaneRevision(paneId);
	}

	// Stop background tracker if one exists — full listener takes over
	stopBackgroundTracking(currentPtyId);

	setPtyStatus(currentPtyId, { type: "running" });
	const actStore = usePtyActivityStore.getState();
	actStore.initPty(currentPtyId);
	actStore.registerPane(paneId, currentPtyId);
	actStore.setCwd(currentPtyId, cwd);

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
			// Always parse and strip shell integration sequences in both modes,
			// so command_end is detected even while in agent mode.
			const { cleaned, commands } = parseShellIntegration(data);

			// Cache store state once per chunk to avoid repeated getState() calls
			const actState = usePtyActivityStore.getState();
			const entry = actState.activities[currentPtyId];
			const isAgentMode = entry?.detectionMode === "agent";

			if (managed.startupBuffer) {
				managed.startupBuffer.push(cleaned);
			} else {
				const output = managed.filterResets
					? stripResetSequences(cleaned)
					: cleaned;
				scheduleWrite(managed, output);
			}

			// Process shell integration commands (agent detection + shell activity)
			for (const cmd of commands) {
				if (cmd.type === "cwd_change") {
					actState.setCwd(currentPtyId, cmd.path ?? "");
					if (cmd.path) {
						useWorkspaceStore.getState().stampCwdOnPane(paneId, cmd.path);
					}
					continue;
				}
				if (cmd.type === "command_start") {
					// Agent detection from command text. setAgentPty mutates
					// the store, so we have to track the transition with a
					// local flag — the captured `isAgentMode` from the top of
					// this chunk is now stale.
					let nowIsAgent = isAgentMode;
					if (cmd.commandText) {
						const agents = useSettingsStore.getState().agents;
						const matched = matchTitleToAgent(cmd.commandText, agents);
						if (matched) {
							actState.setAgentPty(currentPtyId, matched.id);
							nowIsAgent = true;
						}
					}
					if (!nowIsAgent) {
						actState.setRunningCommand(currentPtyId, cmd.commandText ?? "");
					}
					// Critical: the !nowIsAgent guard keeps us from setting
					// shellCommandRunning=true for the agent's own command_start.
					// If that flag stays true, the idle scanner will never
					// transition active → ready (purple) for the agent.
					if (!managed.suppressActivity && !nowIsAgent) {
						setShellCommandRunning(currentPtyId, true);
						actState.recordOutput(currentPtyId);
					}
				} else if (cmd.type === "command_end") {
					actState.setRunningCommand(currentPtyId, null);
					managed.startupShellReady = true;
					tryFlushStartup(managed);
					// Exit agent mode when the command finishes — re-fetch
					// state since setAgentPty above may have mutated it
					const freshState = usePtyActivityStore.getState();
					const currentEntry = freshState.activities[currentPtyId];
					if (currentEntry?.detectionMode === "agent") {
						freshState.clearAgentPty(currentPtyId);
					}
					const wasAgentMode = currentEntry?.detectionMode === "agent";
					if (!managed.suppressActivity && !wasAgentMode) {
						setShellCommandRunning(currentPtyId, false);
						if (cmd.exitCode !== undefined && cmd.exitCode !== 0) {
							freshState.recordError(currentPtyId);
						} else {
							const isFocused =
								document.hasFocus() &&
								useWorkspaceStore.getState().focusedPaneId === paneId;
							if (isFocused) {
								freshState.markIdle(currentPtyId);
							} else {
								freshState.recordExitSuccess(currentPtyId);
							}
						}
					}
				}
			}

			// Agent mode: byte accumulation activity tracking
			if (isAgentMode) {
				const now = Date.now();
				if (
					!managed.suppressActivity &&
					now - managed.lastInputAt > INPUT_GATE_MS
				) {
					if (
						managed.lastOutputChunkAt &&
						now - managed.lastOutputChunkAt > INACTIVITY_RESET_MS
					) {
						managed.bytesSinceIdle = 0;
						// Note: do NOT clear thresholdHitTimes here. Agents
						// naturally pause for several seconds between bursts
						// while thinking; the sliding window in
						// recordThresholdHit handles pruning at its own
						// (longer) cadence. Wiping hits on every 3s gap would
						// prevent the count from ever reaching the threshold.
					}
					managed.lastOutputChunkAt = now;
					managed.bytesSinceIdle += cleaned.length;

					if (entry?.state === "active") {
						touchLastOutput(currentPtyId, now);
					} else if (managed.bytesSinceIdle >= ACTIVITY_BYTE_THRESHOLD) {
						managed.bytesSinceIdle = 0;
						const result = recordThresholdHit(managed.thresholdHitTimes, now);
						managed.thresholdHitTimes = result.hitTimes;
						if (result.fire) {
							usePtyActivityStore.getState().recordOutput(currentPtyId);
						}
					}
				}
			}
		}),

		pty.onActivity(currentPtyId, (activity) => {
			if (managed.suppressActivity) return;

			const actStore = usePtyActivityStore.getState();

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
						useWorkspaceStore.getState().focusedPaneId === paneId;
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
			useWorkspaceStore.getState().setPtyStatus(currentPtyId, status);
		}),

		// Spawn PTY concurrently with listener registration — listeners use
		// event names that include the ptyId, so they won't miss output even
		// if spawn completes first (Tauri buffers events until listen resolves).
		...(isNewPty
			? [
					pty.spawn(
						cwd,
						term.cols,
						term.rows,
						undefined,
						useSettingsStore.getState().shellPath ?? undefined,
						paneId,
						currentPtyId,
					),
				]
			: []),
	]);

	// Safety timeout: flush the startup buffer even if shell integration
	// hooks never fire (e.g. custom shell without integration support).
	// The flush also emits the parked scrollback, so this doubles as the
	// fallback for scrollback restoration on shells without integration.
	if (isNewPty) {
		setTimeout(() => {
			flushStartupBuffer(managed);
		}, 3000);
	} else {
		// Reconnection: the shell is already running so there's no startup
		// buffer to flush. Write parked scrollback immediately — there's no
		// race since no shell init will follow.
		writeRestoreData(managed);
	}

	if (isNewPty) {
		// Write ptyId to the correct tab's layout (not just the active tab)
		const store = useWorkspaceStore.getState();
		const workspace = store.getActiveWorkspace();
		if (workspace) {
			for (const tab of workspace.tabs) {
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
	// clear "ready" → "idle". Focus-changes and keystrokes are handled elsewhere.
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
		if (managed.writeRafId !== null) {
			cancelAnimationFrame(managed.writeRafId);
			flushWrites(managed);
		}
	};

	managed.ready = true;
	bumpPaneRevision(paneId);
}

/** Try to flush the startup buffer. Only flushes once BOTH the terminal is
 *  settled (projected + scrollback written) AND the shell has finished
 *  initializing (command_end received). Adds a short delay to also capture
 *  the shell's resize-triggered redraw that follows projectInto's PTY resize. */
function tryFlushStartup(managed: ManagedTerminal): void {
	if (!managed.startupBuffer || managed.startupFlushScheduled) return;
	if (!managed.settled || !managed.startupShellReady) return; // not ready yet
	managed.startupFlushScheduled = true;
	setTimeout(() => flushStartupBuffer(managed), 200);
}

/** Flush the startup output buffer: first write any parked scrollback so it
 *  lands above the shell prompt, then concatenate the buffered chunks, strip
 *  terminal reset/clear/home sequences, and write the cleaned result. Writing
 *  scrollback here (rather than before PTY spawn) ensures shell startup cannot
 *  clobber restored content — xterm's write queue preserves order, so the
 *  scrollback is guaranteed to render above the shell's first prompt. */
function flushStartupBuffer(managed: ManagedTerminal): void {
	const chunks = managed.startupBuffer;
	if (!chunks) return;
	managed.startupBuffer = null;

	// Emit parked scrollback first so it appears above the shell prompt.
	writeRestoreData(managed);

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

	// Re-arm the reset filter from *flush time*. For non-active tabs, the
	// terminal sits in the 0×0 pool container until the user clicks its tab,
	// so projectInto's beginResizeFilter window starts ticking ~200ms before
	// we get here. Without this, ConPTY's resize-triggered repaint (which on
	// Windows can arrive hundreds of ms later) slips past the filter.
	armFilterResets(managed, 1500);

	// If this pane was launched with an agent, type the agent command into
	// the live shell now that the prompt is visible. Mirrors the pattern used
	// by CommandPalette to launch agents into an existing terminal.
	const pendingAgent = takePendingAgent(managed.paneId);
	if (pendingAgent && managed.ptyId) {
		pty.write(managed.ptyId, `${pendingAgent.command}\n`).catch(() => {});
		usePtyActivityStore.getState().setAgentPty(managed.ptyId);
	}
}

/** Mark terminal as visually settled — loader can now hide */
export function markSettled(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	managed.settled = true;
	tryFlushStartup(managed);
}

/** Enable filterResets for `durationMs`, cancelling any previous timer so
 *  consecutive calls properly extend (or restart) the window rather than
 *  letting the earliest timer race ahead and turn the filter off early. */
function armFilterResets(managed: ManagedTerminal, durationMs: number): void {
	managed.filterResets = true;
	if (managed.filterResetsTimer !== null) {
		clearTimeout(managed.filterResetsTimer);
	}
	managed.filterResetsTimer = setTimeout(() => {
		managed.filterResets = false;
		managed.filterResetsTimer = null;
	}, durationMs);
}

/** Temporarily filter terminal reset sequences from PTY output.
 *  Used around PTY resize during workspace switches and tab projections to
 *  prevent the shell's resize-triggered redraw from wiping existing terminal
 *  content. Safe to call repeatedly — each call resets the timer. */
export function beginResizeFilter(paneId: string): void {
	const managed = instances.get(paneId);
	if (!managed) return;
	armFilterResets(managed, 1500);
}

/** Update scrollback buffer depth on all terminal instances */
export function setAllTerminalsScrollback(scrollback: number): void {
	for (const managed of instances.values()) {
		managed.term.options.scrollback = scrollback;
	}
}

/** Update theme on all terminal instances */
export function setAllTerminalsTheme(theme: ITheme): void {
	for (const managed of instances.values()) {
		managed.term.options.theme = theme;
		// WebGL caches rasterized glyphs in a texture atlas with the old fg/bg
		// colors baked in — clear it so refresh() rebuilds against the new theme.
		managed.webglAddon?.clearTextureAtlas();
		managed.term.refresh(0, managed.term.rows - 1);
	}
}

/** Update font size on all terminal instances and refit */
export function setAllTerminalsFontSize(fontSize: number): void {
	for (const managed of instances.values()) {
		managed.term.options.fontSize = fontSize;
		managed.webglAddon?.clearTextureAtlas();
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
		// WebGL caches rasterized glyphs in a texture atlas — refresh() alone
		// re-renders from the existing atlas and won't pick up the new font.
		// Clearing the atlas forces glyphs to be re-rasterized on next paint.
		managed.webglAddon?.clearTextureAtlas();
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
	bumpPaneRevision(paneId);
	managed.ready = false;
	managed.suppressActivity = true;
	managed.lastInputAt = 0;
	managed.bytesSinceIdle = 0;
	managed.lastOutputChunkAt = 0;
	managed.restoreData = null;
	managed.restoring = false;

	// Get cwd from the active workspace
	const workspace = useWorkspaceStore.getState().getActiveWorkspace();
	const cwd = workspace?.rootFolder ?? ".";

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
	bumpPaneRevision(paneId);
	// Start background tracking so activity dots update for inactive workspaces
	if (managed.ptyId) {
		startBackgroundTracking(managed.ptyId);
	}
}
