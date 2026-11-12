// The Window side of **Agent control** (ADR-0054): Rust checks the caller's
// token and parses the command, then asks the Window that owns the caller's
// Workspace to carry it out. This module answers.

import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
	type AgentControlReply,
	type AgentControlRequestEvent,
	agentControl,
} from "../ipc";
import { getTerminal } from "../terminalManager";
import {
	describeAgent,
	describePane,
	type PaneDescription,
	type PaneLiveFacts,
	paneLabel,
} from "./describe";
import { readBuffer } from "./readBuffer";
import {
	resolveTarget,
	type WorkspacePane,
	workspacePanes,
} from "./resolveTarget";
import { type ControlCaller, ControlError, type ControlRequest } from "./types";

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
		case "pane.read": {
			const pane = resolveTarget(request.target, scope.panes, scope.numbers);
			const managed = getTerminal(pane.node.id);
			if (!managed) {
				throw new ControlError(
					"state_unknown",
					"that pane's terminal is not loaded yet; try again in a moment",
				);
			}
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
		default:
			throw new ControlError(
				"unsupported",
				`\`${request.op}\` is not available in this version of Abundio yet`,
			);
	}
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

/** Requests Rust gave up on. Later steps check this before acting. */
const cancelled = new Set<string>();

export function isCancelled(id: string): boolean {
	return cancelled.has(id);
}

async function onRequest(e: AgentControlRequestEvent): Promise<void> {
	const [outcome] = await Promise.allSettled([
		runRequest(e.caller, e.request as ControlRequest),
	]);
	if (cancelled.delete(e.id)) return;
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
			cancelled.add(id);
		}),
	];
	return () => {
		for (const u of unlistens) u.then((fn) => fn()).catch(() => {});
	};
}
