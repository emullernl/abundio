/**
 * OSC 52 — how a program puts text on the system clipboard.
 *
 * A TUI that offers "copy" without owning the clipboard prints
 * `ESC ] 52 ; <targets> ; <base64> BEL` and trusts the terminal to carry it the
 * rest of the way. Copilot CLI and Claude Code both do, and both print "copied
 * to clipboard" the moment they emit it — they have no way to learn whether
 * anything happened. xterm.js ships no handler for this, so without one the
 * sequence is parsed and dropped, and the user's clipboard silently never
 * changes.
 *
 * Everything here is a decision about untrusted input. The payload arrives as
 * ordinary terminal output, so `cat` of a file someone else wrote can produce
 * any of it, and the effect lands on the user's whole desktop rather than in
 * this pane. Hence: reads refused outright, a size cap, strict UTF-8, and the
 * control-character normalisation below.
 *
 * `terminalManager` registers the handler and does the writing.
 */

import { decodeBase64 } from "./base64";

/** What to do with an OSC 52 payload. */
export type Osc52Action =
	| { kind: "write"; text: string }
	| { kind: "ignore"; reason: Osc52IgnoreReason };

export type Osc52IgnoreReason =
	/** The program asked to READ the clipboard (`Pd` is `?`). Never honoured —
	 *  see below. */
	| "read-refused"
	/** Targets the primary selection only, which we have no equivalent for. */
	| "primary-only"
	/** Arrived while replaying scrollback, so it is not a live request. */
	| "restoring"
	/** Payload was longer than the cap, or not decodable base64/UTF-8. */
	| "rejected";

/** Ceiling on a single clipboard write, in decoded bytes.
 *
 *  1 MiB is far above any real "copy this snippet" and far below a size that
 *  would make the write itself a denial of service. */
export const OSC52_MAX_BYTES = 1024 * 1024;

/** State the caller has that this module cannot see. */
export interface Osc52Context {
	/** Whether xterm is replaying saved scrollback rather than live output. */
	restoring: boolean;
}

/**
 * Normalise text on its way to the clipboard.
 *
 * A bare `\r` is an execute-on-paste vector: `"git status\rrm -rf ~\r"` is
 * valid UTF-8, well under the cap, and emitted by any file someone `cat`s.
 * Pasted into a shell that is not in bracketed-paste mode, both lines run with
 * no Enter pressed. Bracketed paste covers the common case *inside* Abundio,
 * but a clipboard is system-wide — the next paste may be into another terminal
 * or a readline that does not bracket.
 *
 * So `\r` (and `\r\n`) become `\n`, which keeps every legitimate multi-line
 * copy working while removing the property that makes CR dangerous, and the
 * remaining C0 controls are dropped. Tab and newline stay: they are the two a
 * copied snippet actually needs.
 *
 * Deliberately more than xterm's own OSC 52 support and `@xterm/addon-clipboard`
 * do. Refusing clipboard reads while passing CR straight through would be a
 * strange place to draw the line.
 */
function normalizeClipboardText(text: string): string {
	return (
		text
			// CRLF and lone CR alike collapse to a single LF.
			.replace(/\r\n?/g, "\n")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
	);
}

/**
 * Interpret an OSC 52 payload — everything after `52;`, i.e. `<targets>;<data>`.
 *
 * **Reads are always refused.** `Pd` of `?` asks the terminal to send the
 * clipboard *back to the program* as an input sequence. That turns any program,
 * or any file someone `cat`s, into a clipboard exfiltration channel — passwords
 * and tokens included. xterm, iTerm2 and Ghostty all default it off; we do not
 * implement it at all, so there is no setting to get wrong.
 */
export function parseOsc52(data: string, ctx: Osc52Context): Osc52Action {
	// Replayed scrollback carries the OSC 52s of a session that has ended.
	// Honouring them would replace whatever is on the clipboard right now, at app
	// start, with something copied yesterday.
	//
	// Note this is the bare `restoring`, NOT the mouse hooks'
	// `restoring && !restoreIsLive`. The divergence is deliberate: a live PTY's
	// log is no better here, because the program already got its clipboard write
	// when those bytes were first produced. Replaying it would write twice.
	if (ctx.restoring) return { kind: "ignore", reason: "restoring" };

	const sep = data.indexOf(";");
	// No separator at all is malformed: `Pc` may be empty, but its `;` may not.
	if (sep === -1) return { kind: "ignore", reason: "rejected" };

	const targets = data.slice(0, sep);
	const payload = data.slice(sep + 1);

	if (payload === "?") return { kind: "ignore", reason: "read-refused" };

	// An empty `Pc` means the default, `s0` — the selection plus cut buffer 0.
	// `p` alone is the X11 PRIMARY selection, a different thing from the
	// clipboard with no equivalent on any platform we ship; honouring it would
	// mean every mouse selection in a TUI silently replaced the real clipboard.
	if (targets.length > 0 && !/[cs0-7]/.test(targets)) {
		return { kind: "ignore", reason: "primary-only" };
	}

	// An empty payload is a legitimate "clear the clipboard".
	if (payload.length === 0) return { kind: "write", text: "" };

	// Cheap length check before decoding: 4 base64 chars carry 3 bytes. This
	// over-approximates by ignoring padding, so a fully padded payload within a
	// byte or two of the cap is refused. Nobody is copying exactly 1 MiB.
	if ((payload.length / 4) * 3 > OSC52_MAX_BYTES) {
		return { kind: "ignore", reason: "rejected" };
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) {
		return { kind: "ignore", reason: "rejected" };
	}

	const bytes = decodeBase64(payload);
	if (bytes.length === 0) return { kind: "ignore", reason: "rejected" };

	// Programs emit UTF-8 here. Decode strictly rather than salvaging: a payload
	// that is not valid UTF-8 was not text we were meant to put on the clipboard.
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { kind: "write", text: normalizeClipboardText(text) };
	} catch {
		return { kind: "ignore", reason: "rejected" };
	}
}
