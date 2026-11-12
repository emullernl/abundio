// The Window side of **Agent control** (ADR-0054): Rust checks the caller's
// token and parses the command, then asks the Window that owns the caller's
// Workspace to carry it out. This module answers.

import { useControlBadgeStore } from "../../stores/controlBadgeStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { checkHandle } from "../agentHandle";
import { closePaneNow } from "../closePane";
import { pasteAndSubmit } from "../firePromptAction";
import { fleetConsoleShowing } from "../fleetFocus";
import {
	type AgentControlReply,
	type AgentControlRequestEvent,
	agentControl,
	agentHooks,
	pty,
	shells,
} from "../ipc";
import { shellSupportsTasks } from "../newTask";
import { revealPane } from "../paneLocation";
import { collectTerminalIds, parseTabLayout, wrapInSplit } from "../paneTree";
import { setPendingTask, takePendingTask } from "../pendingAgentRegistry";
import { canFire } from "../promptActions";
import { taskTabName } from "../taskPrompt";
import { getTerminal, type ManagedTerminal } from "../terminalManager";
import type { CodingAgent } from "../types";
import { crowdHint } from "./crowding";
import {
	describeAgent,
	describePane,
	type PaneDescription,
	type PaneLiveFacts,
	paneLabel,
} from "./describe";
import { keysToBytes } from "./keys";
import { cleanPromptText } from "./promptText";
import { readBuffer } from "./readBuffer";
import {
	resolveTarget,
	type TerminalNode,
	type WorkspacePane,
	workspacePanes,
} from "./resolveTarget";
import {
	autoDirection,
	cleanCommand,
	closeRefusal,
	layoutDirection,
	runRefusal,
	startArgv,
	tabRenameRefusal,
} from "./spawn";
import {
	type ControlCaller,
	ControlError,
	type ControlRequest,
	type Direction,
} from "./types";
import { type WaitOutcome, waitForPane } from "./waitForPane";

/** The caller's Workspace as this Window sees it right now. */
interface Scope {
	caller: ControlCaller;
	panes: WorkspacePane[];
	numbers: Map<string, number>;
}

async function loadScope(caller: ControlCaller): Promise<Scope> {
	const ws = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === caller.workspaceId);
	if (!ws) {
		throw new ControlError(
			"not_found",
			"your Workspace is not open in this Window",
		);
	}
	const panes = workspacePanes(ws.tabs);
	const numbers = new Map(
		await agentControl.paneNumbers(
			ws.id,
			panes.map((p) => p.node.id),
		),
	);
	return { caller, panes, numbers };
}

function ptyIdOf(pane: WorkspacePane): string {
	const id = pane.node.id;
	return (
		getTerminal(id)?.ptyId ||
		usePtyActivityStore.getState().panePtyMap[id] ||
		pane.node.ptyId
	);
}

function liveFacts(pane: WorkspacePane): PaneLiveFacts {
	const ptyId = ptyIdOf(pane);
	const act = usePtyActivityStore.getState();
	const entry = ptyId ? act.activities[ptyId] : undefined;
	const status = ptyId
		? useWorkspaceStore.getState().ptyStatuses[ptyId]
		: undefined;
	return {
		state: entry?.state ?? null,
		mode: entry?.detectionMode ?? null,
		exited: status?.type === "exited",
		detectedAgentId: (ptyId && act.detectedAgentIds[ptyId]) || null,
		cwd: (ptyId && act.cwds[ptyId]) || null,
		title: act.titles[pane.node.id] || null,
		runningCommand: (ptyId && act.runningCommands[ptyId]) || null,
	};
}

function describeAll(scope: Scope): PaneDescription[] {
	return scope.panes.map((p) =>
		describePane(p, liveFacts(p), scope.numbers, scope.caller.paneId),
	);
}

/** Carry out one request. Throws `ControlError` for an answer the Agent
 *  should see as an error. Exported for tests. */
export async function runRequest(
	caller: ControlCaller,
	request: ControlRequest,
	signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
	const scope = await loadScope(caller);
	switch (request.op) {
		case "resolve": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return { paneId: pane.node.id };
		}
		case "pane.list":
			return { panes: describeAll(scope) };
		case "pane.current": {
			const pane = scope.panes.find((p) => p.node.id === caller.paneId);
			if (!pane) {
				throw new ControlError("not_found", "your pane is no longer open");
			}
			return describePane(pane, liveFacts(pane), scope.numbers, caller.paneId);
		}
		case "agent.list":
			return {
				agents: describeAll(scope)
					.filter((p) => p.mode === "agent")
					.map(describeAgent),
			};
		case "agent.rename": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return withBadge(scope, pane, () => {
				const facts = liveFacts(pane);
				if (facts.mode !== "agent") {
					throw new ControlError(
						"not_an_agent",
						"that pane is not running an Agent; only Agents have handles",
					);
				}
				const check = useWorkspaceStore
					.getState()
					.setAgentHandle(pane.node.id, request.handle);
				if (!check.ok) throw new ControlError(check.code, check.message);
				const node = { ...pane.node, agentHandle: request.handle ?? undefined };
				return describeAgent(
					describePane({ ...pane, node }, facts, scope.numbers, caller.paneId),
				);
			});
		}
		case "pane.read": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return withBadge(scope, pane, () => readPane(scope, pane, request));
		}
		case "agent.prompt": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return withBadge(scope, pane, () =>
				promptAgent(scope, pane, request, signal),
			);
		}
		case "agent.wait": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return withBadge(scope, pane, async () => {
				requireAgent(pane);
				const outcome = await waitForPane(
					pane.node.id,
					ptyIdOf(pane),
					{ until: request.until, needWorking: false },
					signal,
				);
				return waitResult(scope, pane, outcome);
			});
		}
		case "agent.sendKeys": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return withBadge(scope, pane, async () => {
				const managed = mountedTerminal(pane);
				const appCursor = managed.term.modes.applicationCursorKeysMode;
				const keys = keysToBytes(request.keys, appCursor);
				if (!keys.ok) {
					throw new ControlError(
						"internal",
						`unknown key "${keys.unknown}"; nothing was sent`,
					);
				}
				await pty.write(managed.ptyId, keys.bytes);
				return {
					pane: paneLabel(scope.numbers.get(pane.node.id) ?? 0),
					sent: request.keys.length,
				};
			});
		}
		case "pane.split": {
			const { paneId, hint } = await splitCaller(scope, request.direction, {});
			if (request.focus) focusNewPane(scope, paneId);
			return withHint(await describeNew(caller, paneId), hint);
		}
		case "agent.start":
			return startAgent(scope, request, signal);
		case "tab.new": {
			const paneId = await openSpawnedTab(scope, {
				handle: null,
				name: request.name ?? undefined,
				focus: request.focus,
			});
			return describeNew(caller, paneId);
		}
		case "tab.rename":
			return renameTabFor(scope, request);
		case "pane.run": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			return withBadge(scope, pane, async () => {
				const managed = mountedTerminal(pane);
				const facts = liveFacts(pane);
				const refusal = runRefusal({
					mode: facts.mode,
					exited: facts.exited,
					integrationSeen: managed.shellIntegrationSeen,
					shellCommandRunning:
						usePtyActivityStore.getState().activities[managed.ptyId]
							?.shellCommandRunning === true,
				});
				if (refusal) throw refusal;
				const command = cleanCommand(request.command);
				if (command === "") {
					throw new ControlError("empty_prompt", "the command is empty");
				}
				await pty.write(managed.ptyId, `${command}\r`);
				return {
					pane: paneLabel(scope.numbers.get(pane.node.id) ?? 0),
					sent: true,
				};
			});
		}
		case "pane.close": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			const refusal = closeRefusal(
				pane.node.spawnedBy,
				caller.paneId,
				pane.node.id,
			);
			if (refusal) throw refusal;
			const label = paneLabel(scope.numbers.get(pane.node.id) ?? 0);
			await closePaneNow(pane.node.id, { keepFocus: true });
			return { pane: label, closed: true };
		}
		default:
			throw new ControlError(
				"unsupported",
				`\`${(request as { op: string }).op}\` is not available in this version of Abundio`,
			);
	}
}

/** How long `agent start` waits for the new pane to reach agent mode. */
export const START_STALL_MS = 30_000;
const START_POLL_MS = 200;

/** Resolve once `ready()` holds; reject with `stalled` after `limitMs`, or
 *  when `signal` aborts. */
function waitUntil(
	ready: () => boolean,
	limitMs: number,
	signal: AbortSignal,
	stalledMessage: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (signal.aborted) return reject(new Error("cancelled"));
			if (ready()) return resolve();
			if (Date.now() - started >= limitMs) {
				return reject(new ControlError("stalled", stalledMessage));
			}
			setTimeout(tick, START_POLL_MS);
		};
		tick();
	});
}

/**
 * Split the caller's pane and return the new pane's id. The new pane is a
 * **Spawned pane** owned by the caller. Keyboard focus does not move: the
 * user may be typing somewhere else entirely.
 */
async function splitCaller(
	scope: Scope,
	direction: Direction | null,
	extra: Partial<TerminalNode>,
): Promise<{ paneId: string; hint: string | null }> {
	const self = scope.panes.find((p) => p.node.id === scope.caller.paneId);
	if (!self) {
		throw new ControlError("not_found", "your pane is no longer open");
	}
	const store = useWorkspaceStore.getState();
	const tab = store.workspaces
		.find((w) => w.id === scope.caller.workspaceId)
		?.tabs.find((t) => t.id === self.tabId);
	const layout = tab ? parseTabLayout(tab.layoutJson) : null;
	if (!tab || !layout) {
		throw new ControlError("not_found", "your pane's Tab is no longer open");
	}
	const term = getTerminal(self.node.id)?.term;
	const side = direction ?? autoDirection(term?.cols ?? 80, term?.rows ?? 24);
	const node: TerminalNode = {
		type: "terminal",
		id: crypto.randomUUID(),
		ptyId: "",
		...extra,
		spawnedBy: scope.caller.paneId,
	};
	const hint = crowdHint({
		terminalPanes: collectTerminalIds(layout).length,
		cols: term?.cols ?? 80,
		rows: term?.rows ?? 24,
		direction: side,
	});
	const next = wrapInSplit(layout, self.node.id, node, layoutDirection(side));
	await store.updateLayout(tab.id, next);
	return { paneId: node.id, hint };
}

function focusNewPane(scope: Scope, paneId: string): void {
	const self = scope.panes.find((p) => p.node.id === scope.caller.paneId);
	if (self) revealPane(paneId, scope.caller.workspaceId, self.tabId);
}

/** The new pane as `pane list` would show it (which also numbers it). */
async function describeNew(caller: ControlCaller, paneId: string) {
	const scope = await loadScope(caller);
	const pane = scope.panes.find((p) => p.node.id === paneId);
	if (!pane) throw new ControlError("not_found", "the new pane closed again");
	return describePane(pane, liveFacts(pane), scope.numbers, caller.paneId);
}

/**
 * `agent start`: split the caller and launch an Agent in the new pane
 * through the **New task** path (its argv rides the spawn; nothing is
 * typed). Answers once the pane is in agent mode.
 */
async function startAgent(
	scope: Scope,
	request: Extract<ControlRequest, { op: "agent.start" }>,
	signal: AbortSignal,
) {
	const settings = useSettingsStore.getState();
	const { agent, argv } = startArgv(
		settings.agents,
		request.kind,
		request.prompt === null ? null : cleanPromptText(request.prompt),
		request.args,
	);
	const shell = settings.shellPath || (await shells.default().catch(() => ""));
	if (shell && !shellSupportsTasks(shell)) {
		throw new ControlError(
			"unsupported_shell",
			"agents can only be started in zsh or bash panes; change the shell in Settings",
		);
	}
	if (request.handle !== null) {
		const ws = useWorkspaceStore
			.getState()
			.workspaces.find((w) => w.id === scope.caller.workspaceId);
		const check = checkHandle(ws?.tabs ?? [], "", request.handle);
		if (!check.ok) throw new ControlError(check.code, check.message);
	}
	// Register the Agent's hooks before it starts, as a split launch does,
	// capped so a slow disk cannot hold the call up.
	if (settings.agentHooksEnabled) {
		await Promise.race([
			agentHooks.ensure(agent.id, true).catch(() => {}),
			new Promise((r) => setTimeout(r, 2000)),
		]);
	}
	let paneId: string;
	let hint: string | null = null;
	if (request.tab) {
		paneId = await openSpawnedTab(scope, {
			agent,
			argv,
			handle: request.handle,
			name:
				request.tabName ??
				(request.prompt !== null
					? taskTabName({ kind: "text", input: request.prompt })
					: (request.handle ?? agent.name)),
			focus: request.focus,
		});
	} else {
		// Seeded before the pane is in the layout: its terminal takes the task
		// when it spawns, which can happen as soon as the layout renders.
		paneId = crypto.randomUUID();
		setPendingTask(paneId, { argv, agentId: agent.id });
		try {
			({ hint } = await splitCaller(scope, request.direction, {
				id: paneId,
				agentId: agent.id,
				...(request.handle !== null ? { agentHandle: request.handle } : {}),
			}));
		} catch (e) {
			takePendingTask(paneId);
			throw e;
		}
		if (request.focus) focusNewPane(scope, paneId);
	}
	await waitUntil(
		() => {
			const ptyId =
				getTerminal(paneId)?.ptyId ||
				usePtyActivityStore.getState().panePtyMap[paneId];
			return (
				!!ptyId &&
				usePtyActivityStore.getState().activities[ptyId]?.detectionMode ===
					"agent"
			);
		},
		START_STALL_MS,
		signal,
		"the pane opened, but its Agent did not start within 30 seconds; read the pane to see why",
	);
	// In the Fleet Console its tile exists only now that it is in agent mode.
	if (request.focus && fleetConsoleShowing()) {
		useWindowUiStore.getState().setFocusedTile(paneId);
	}
	return withHint(describeAgent(await describeNew(scope.caller, paneId)), hint);
}

/** A reply with a crowded-Tab `hint` when there is one (`crowding.ts`). */
function withHint<T extends object>(reply: T, hint: string | null): T {
	return hint ? { ...reply, hint } : reply;
}

/**
 * Open a **Spawned tab** owned by the caller: at the end of the Tab bar,
 * through the same path as New task's New tab (an Agent's argv rides the
 * spawn). The user's view does not change unless `focus`. Returns the new
 * pane's id.
 */
async function openSpawnedTab(
	scope: Scope,
	opts: {
		agent?: CodingAgent;
		argv?: string[];
		handle: string | null;
		name: string | undefined;
		focus: boolean;
	},
): Promise<string> {
	let seeded: string | null = null;
	const { agent, argv } = opts;
	const tab = await useWorkspaceStore
		.getState()
		.createTab(scope.caller.workspaceId, agent, undefined, {
			activate: false,
			name: opts.name,
			...(agent && argv
				? {
						task: {
							argv,
							agentId: agent.id,
							tabName: opts.name ?? agent.name,
							onSeeded: (id: string) => {
								seeded = id;
							},
						},
					}
				: {}),
			spawn: {
				ownerPaneId: scope.caller.paneId,
				...(opts.handle !== null ? { handle: opts.handle } : {}),
			},
		});
	const layout = parseTabLayout(tab.layoutJson);
	const paneId = seeded ?? (layout ? collectTerminalIds(layout)[0] : undefined);
	if (!paneId) throw new ControlError("internal", "the new Tab has no pane");
	if (opts.focus) revealPane(paneId, scope.caller.workspaceId, tab.id);
	return paneId;
}

/** `tab rename`: the caller's own Tab, or one it opened, and never one the
 *  user has named by hand. */
async function renameTabFor(
	scope: Scope,
	request: Extract<ControlRequest, { op: "tab.rename" }>,
) {
	const self = scope.panes.find((p) => p.node.id === scope.caller.paneId);
	if (!self) {
		throw new ControlError("not_found", "your pane is no longer open");
	}
	const pane = request.target
		? resolveTarget(request.target, scope.panes, scope.numbers)
		: self;
	const tab = useWorkspaceStore
		.getState()
		.workspaces.find((w) => w.id === scope.caller.workspaceId)
		?.tabs.find((t) => t.id === pane.tabId);
	if (!tab) throw new ControlError("not_found", "that Tab is no longer open");
	const refusal = tabRenameRefusal({
		ownTab: tab.id === self.tabId,
		spawnedByCaller: tab.spawnedByPane === scope.caller.paneId,
		userNamed: tab.userNamed === true,
	});
	if (refusal) throw refusal;
	await useWorkspaceStore.getState().renameTab(tab.id, request.name);
	return { tab: request.name, renamed: true };
}

/** The caller as the badge names it: its handle, else its Pane number. */
export function callerLabel(scope: Scope): string {
	const self = scope.panes.find((p) => p.node.id === scope.caller.paneId);
	if (self?.node.agentHandle) return self.node.agentHandle;
	const n = scope.numbers.get(scope.caller.paneId);
	return n !== undefined ? paneLabel(n) : "an Agent";
}

/** Run `fn` with the **Control badge** on `pane`. An Agent acting on its own
 *  pane gets no badge: nobody else is driving it. */
async function withBadge<T>(
	scope: Scope,
	pane: WorkspacePane,
	fn: () => T | Promise<T>,
): Promise<T> {
	if (pane.node.id === scope.caller.paneId) return fn();
	const end = useControlBadgeStore
		.getState()
		.begin(pane.node.id, callerLabel(scope));
	try {
		return await fn();
	} finally {
		end();
	}
}

function mountedTerminal(pane: WorkspacePane): ManagedTerminal {
	const managed = getTerminal(pane.node.id);
	if (!managed?.ptyId) {
		throw new ControlError(
			"state_unknown",
			"that pane's terminal is not loaded yet; try again in a moment",
		);
	}
	return managed;
}

function requireAgent(pane: WorkspacePane): PaneLiveFacts {
	const facts = liveFacts(pane);
	if (facts.exited || facts.mode !== "agent") {
		throw new ControlError(
			"not_an_agent",
			"that pane is not running an Agent; use `abundio pane run` for a shell",
		);
	}
	return facts;
}

function waitResult(scope: Scope, pane: WorkspacePane, outcome: WaitOutcome) {
	return {
		...describeAgent(
			describePane(pane, liveFacts(pane), scope.numbers, scope.caller.paneId),
		),
		status: outcome.end === "left" ? "exited" : outcome.end,
		waitedMs: outcome.waitedMs,
	};
}

/** `agent prompt`: paste the text into the Agent and press Enter, without
 *  moving keyboard focus; with `--wait`, until it has Settled. */
async function promptAgent(
	scope: Scope,
	pane: WorkspacePane,
	request: Extract<ControlRequest, { op: "agent.prompt" }>,
	signal: AbortSignal,
) {
	const managed = mountedTerminal(pane);
	const facts = requireAgent(pane);
	if (!canFire(facts.state ?? undefined)) {
		throw new ControlError(
			"busy",
			"that Agent is Waiting for an answer (a permission prompt, say); read the pane, answer it with `agent send-keys`, then prompt again",
		);
	}
	const text = cleanPromptText(request.text);
	if (text.trim() === "") {
		throw new ControlError(
			"empty_prompt",
			"nothing is left of the prompt once control characters are removed",
		);
	}
	// Watch first, so a fast Agent's Working cannot happen before we look.
	const waiting = request.wait
		? waitForPane(
				pane.node.id,
				managed.ptyId,
				{ until: "settled", needWorking: true },
				signal,
			)
		: null;
	pasteAndSubmit(managed, text, true);
	const label = paneLabel(scope.numbers.get(pane.node.id) ?? 0);
	if (!waiting) return { pane: label, sent: true };
	return { sent: true, ...waitResult(scope, pane, await waiting) };
}

function readPane(
	scope: Scope,
	pane: WorkspacePane,
	request: Extract<ControlRequest, { op: "pane.read" }>,
) {
	const managed = mountedTerminal(pane);
	const lines = readBuffer(managed.term.buffer.active, managed.term.rows, {
		lines: request.lines,
		visible: request.visible,
	});
	return {
		pane: paneLabel(scope.numbers.get(pane.node.id) ?? 0),
		lines: lines.length,
		text: lines.join("\n"),
	};
}

/** Turn a handler's outcome into the reply Rust expects. */
export function toReply(
	outcome: PromiseSettledResult<unknown>,
): AgentControlReply {
	if (outcome.status === "fulfilled") return { result: outcome.value ?? null };
	const err = outcome.reason;
	if (err instanceof ControlError) {
		return { error: { code: err.code, message: err.message } };
	}
	return {
		error: {
			code: "internal",
			message: err instanceof Error ? err.message : String(err),
		},
	};
}

/** Requests still running, so Rust's cancel (its timeout) can stop a wait. */
const running = new Map<string, AbortController>();

async function onRequest(e: AgentControlRequestEvent): Promise<void> {
	const abort = new AbortController();
	running.set(e.id, abort);
	const [outcome] = await Promise.allSettled([
		runRequest(e.caller, e.request as ControlRequest, abort.signal),
	]);
	running.delete(e.id);
	// Rust has stopped listening; it already answered the Agent.
	if (abort.signal.aborted) return;
	await agentControl.reply(e.id, toReply(outcome)).catch(() => {});
}

/**
 * Answer Agent control requests aimed at this Window. Profile windows only:
 * File windows and Settings own no Workspace panes. Returns the unlisten.
 */
export function startAgentControl(): () => void {
	const unlistens = [
		agentControl.onRequest((e) => {
			void onRequest(e);
		}),
		agentControl.onCancel((id) => {
			running.get(id)?.abort();
		}),
	];
	return () => {
		for (const u of unlistens) u.then((fn) => fn()).catch(() => {});
	};
}
