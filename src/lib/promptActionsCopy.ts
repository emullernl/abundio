import { joinedApi, promptActions } from "./ipc";
import type { PromptActionCreate, PromptActionRow } from "./types";

/**
 * Prompt actions are this computer's (ADR-0064); until phase 10d-2 a remote
 * Window kept its Host's. Each Host's are copied here once: the ones this
 * computer does not already have, by name, text and scope, in the Host's
 * order. Running it again never makes doubles.
 */
export function actionsToCopy(
	host: PromptActionRow[],
	mine: PromptActionRow[],
): PromptActionCreate[] {
	const key = (a: PromptActionRow) =>
		JSON.stringify([a.name, a.body, a.scopeKind, [...a.scopeAgentIds].sort()]);
	const have = new Set(mine.map(key));
	return [...host]
		.sort((a, b) => a.position - b.position)
		.filter((a) => !have.has(key(a)))
		.map((a) => ({
			name: a.name,
			body: a.body,
			scopeKind: a.scopeKind,
			scopeAgentIds: a.scopeAgentIds,
			paramsJson: a.paramsJson,
			showInBar: a.showInBar,
		}));
}

const flag = (hostId: string) => `abundio-prompt-actions-copied:${hostId}`;

/** Copy a Host's Prompt actions to this computer, once per Host. */
export async function copyHostPromptActionsOnce(
	hostId: string,
): Promise<number> {
	try {
		if (localStorage.getItem(flag(hostId))) return 0;
	} catch {
		// No storage: the copy is harmless to repeat.
	}
	const host = await joinedApi.callOn<PromptActionRow[]>(
		hostId,
		"prompt_actions_list",
		{},
	);
	const mine = await promptActions.list();
	const todo = actionsToCopy(host, mine);
	for (const a of todo) await promptActions.create(a);
	try {
		localStorage.setItem(flag(hostId), "1");
	} catch {}
	if (todo.length > 0) {
		console.info(
			`[prompt actions] copied ${todo.length} from ${hostId} to this computer`,
		);
	}
	return todo.length;
}
