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
 * This module decides what a given payload means; `terminalManager` registers
 * the handler and does the writing.
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
	/** Payload was longer than the cap, or not decodable base64. */
	| "rejected";

/** Ceiling on a single clipboard write, in decoded bytes.
 *
 *  A clipboard write is a side effect on the user's whole desktop, and the
 *  payload arrives as ordinary terminal output — `cat` of an arbitrary file can
 *  produce it. 1 MiB is far above any real "copy this snippet" and far below a
 *  size that would make the write itself a denial of service. */
export const OSC52_MAX_BYTES = 1024 * 1024;

/**
 * Interpret an OSC 52 payload — everything after `52;`, i.e. `<targets>;<data>`.
 *
 * **Reads are always refused.** `Pd` of `?` asks the terminal to send the
 * clipboard *back to the program* as an input sequence. That turns any program,
 * or any file someone `cat`s, into a clipboard exfiltration channel — passwords
 * and tokens included. xterm, iTerm2 and Ghostty all default it off; we do not
 * implement it at all, so there is no setting to get wrong.
 */
export function parseOsc52(data: string): Osc52Action {
	const sep = data.indexOf(";");
	// No separator at all is malformed: `Pc` may be empty, but its `;` may not.
	if (sep === -1) return { kind: "ignore", reason: "rejected" };

	const targets = data.slice(0, sep);
	const payload = data.slice(sep + 1);

	if (payload === "?") return { kind: "ignore", reason: "read-refused" };

	// An empty `Pc` means the default, `s0` — the selection plus cut buffer 0.
	// `p` alone is the X11 PRIMARY selection, which is a different thing from the
	// clipboard and has no equivalent on any platform we ship; honouring it would
	// mean every mouse selection in a TUI silently replaced the real clipboard.
	if (targets.length > 0 && !/[cs0-7]/.test(targets)) {
		return { kind: "ignore", reason: "primary-only" };
	}

	// An empty payload is a legitimate "clear the clipboard".
	if (payload.length === 0) return { kind: "write", text: "" };

	// Cheap length check before decoding: 4 base64 chars carry 3 bytes.
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
		return { kind: "write", text };
	} catch {
		return { kind: "ignore", reason: "rejected" };
	}
}
