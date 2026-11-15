/**
 * What the New Workspace dialog says about a chosen folder (GLOSSARY.md,
 * Workspace): one folder per Profile, never an Orchestrator folder, another
 * Profile's Workspace may share it. Pure.
 */

import type { FolderCheck } from "./ipc";

export interface FolderVerdict {
	/** Refused: the dialog cannot add it. */
	blocked: boolean;
	/** What the dialog shows under the folder, or null. */
	message: string | null;
	/** The Workspace to offer instead (`Open <name>`). */
	open: { id: string; name: string } | null;
}

export function folderVerdict(check: FolderCheck | null): FolderVerdict {
	if (!check) return { blocked: false, message: null, open: null };
	if (check.orchestrator) {
		return {
			blocked: true,
			message: "This is the Orchestrator's folder; choose another.",
			open: null,
		};
	}
	if (check.takenBy) {
		return {
			blocked: true,
			message: `${check.takenBy.name} already uses this folder.`,
			open: check.takenBy,
		};
	}
	if (check.otherProfiles.length > 0) {
		const names = check.otherProfiles.join(", ");
		return {
			blocked: false,
			message: `Also a Workspace in ${names}. Agents of both can pick up each other's conversations in this folder.`,
			open: null,
		};
	}
	return { blocked: false, message: null, open: null };
}
