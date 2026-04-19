import type { DetectedDevEnvironment } from "./types";

export const DEFAULT_DEV_ENV_ID = "vscode";

/**
 * Pick the dev environment that should power the primary button click.
 * Preference order: last-used → VSCode (if installed) → first installed.
 */
export function pickActiveDevEnvId(
	installed: DetectedDevEnvironment[],
	lastOpenedId: string | null,
): string | null {
	if (lastOpenedId && installed.some((e) => e.id === lastOpenedId)) {
		return lastOpenedId;
	}
	if (installed.some((e) => e.id === DEFAULT_DEV_ENV_ID)) {
		return DEFAULT_DEV_ENV_ID;
	}
	return installed[0]?.id ?? null;
}
