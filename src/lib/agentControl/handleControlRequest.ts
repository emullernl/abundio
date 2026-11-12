// The Window side of **Agent control** (ADR-0054): Rust checks the caller's
// token and parses the command, then asks the Window that owns the caller's
// Workspace to carry it out. This module answers.

import { useControlBadgeStore } from "../../stores/controlBadgeStore";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { pasteAndSubmit } from "../firePromptAction";
import {
	type AgentControlReply,
	type AgentControlRequestEvent,
	agentControl,
	pty,
} from "../ipc";
import { canFire } from "../promptActions";
import { getTerminal, type ManagedTerminal } from "../terminalManager";
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
	type WorkspacePane,
	workspacePanes,
} from "./resolveTarget";
import { type ControlCaller, ControlError, type ControlRequest } from "./types";
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
		default:
			throw new ControlError(
				"unsupported",
				`\`${request.op}\` is not available in this version of Abundio yet`,
			);
	}
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
