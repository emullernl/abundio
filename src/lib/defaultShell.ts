import { shells } from "./ipc";

// The PTY's "System Default" shell (used when Settings has no `shellPath`),
// resolved once in Rust and memoized. An empty string means it could not be
// resolved.
let resolved: string | null = null;
let inflight: Promise<string> | null = null;

export function getDefaultShell(): Promise<string> {
	if (resolved !== null) return Promise.resolve(resolved);
	if (!inflight) {
		inflight = Promise.resolve()
			.then(() => shells.default())
			.then((s) => {
				resolved = s;
				return s;
			})
			.catch(() => {
				resolved = "";
				return "";
			});
	}
	return inflight;
}

/** The default shell if it has been resolved already, else null. Starts the
 *  lookup so a later call can answer. */
export function peekDefaultShell(): string | null {
	if (resolved === null) void getDefaultShell();
	return resolved || null;
}
