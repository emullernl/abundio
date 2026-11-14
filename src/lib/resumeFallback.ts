/**
 * The one retry a **Session resume** gets (ADR-0050, amended): a relaunch
 * line that resumes (`--continue`, `--resume <id>`) and exits non-zero within
 * `RESUME_FALLBACK_MS` of being typed is taken to have found nothing to
 * resume ("No conversation found to continue"), and the plain launch line is
 * typed instead, once.
 *
 * Not a shell `|| plain`: a shell cannot tell a failed resume from the user
 * quitting the resumed Agent with a non-zero exit (Copilot exits 1 on
 * Ctrl+C) however late. The short window is what tells them apart: an
 * Agent that started fine and was used for a while is not retried. Pure.
 */

/** How long after the relaunch line a failure still counts as "nothing to
 *  resume". An Agent with no session fails within a second or two. */
export const RESUME_FALLBACK_MS = 8000;

export interface ResumeFallback {
	/** The plain launch line. */
	command: string;
	/** Epoch ms after which the retry no longer applies. */
	until: number;
}

/**
 * The line to type now, if any, when the shell reports the end of the
 * command that followed a resume. Whatever the answer, the fallback is used
 * up: one command, one chance.
 */
export function fallbackAfterExit(
	fallback: ResumeFallback | null,
	exitCode: number | null | undefined,
	now: number,
): string | null {
	if (!fallback) return null;
	if (typeof exitCode !== "number" || exitCode === 0) return null;
	return now <= fallback.until ? fallback.command : null;
}
