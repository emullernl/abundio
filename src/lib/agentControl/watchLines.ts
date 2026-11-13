// `pane watch` (ADR-0056): a pane's output, as it arrives, made into plain
// lines and tested against a pattern. Pure: the handler feeds it bytes.

/**
 * Turns a terminal byte stream into text without escape sequences. CSI
 * (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`), DCS/APC/PM/SOS strings
 * and two-byte escapes are dropped, as are control characters other than
 * CR, LF and tab. A sequence cut off at the end of a chunk is held for the
 * next one.
 */
export class EscapeStripper {
	private decoder = new TextDecoder("utf-8");
	private held = "";

	feed(bytes: Uint8Array): string {
		const s = this.held + this.decoder.decode(bytes, { stream: true });
		this.held = "";
		let out = "";
		let i = 0;
		while (i < s.length) {
			const c = s[i];
			if (c !== "\x1b") {
				const code = c.charCodeAt(0);
				if (code >= 0x20 || c === "\n" || c === "\r" || c === "\t") {
					if (code !== 0x7f) out += c;
				}
				i++;
				continue;
			}
			const end = escapeEnd(s, i);
			if (end === null) {
				this.held = s.slice(i);
				break;
			}
			i = end;
		}
		return out;
	}
}

/** Index just past the escape sequence starting at `i`, or null when the
 *  sequence is not complete yet. */
function escapeEnd(s: string, i: number): number | null {
	const kind = s[i + 1];
	if (kind === undefined) return null;
	if (kind === "[") {
		for (let j = i + 2; j < s.length; j++) {
			const code = s.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j + 1;
		}
		return null;
	}
	if (
		kind === "]" ||
		kind === "P" ||
		kind === "_" ||
		kind === "^" ||
		kind === "X"
	) {
		for (let j = i + 2; j < s.length; j++) {
			if (s[j] === "\x07") return j + 1;
			if (s[j] === "\x1b") {
				if (j + 1 >= s.length) return null;
				if (s[j + 1] === "\\") return j + 2;
			}
		}
		return null;
	}
	// A charset designation takes one more byte.
	if ("()*+".includes(kind)) return i + 2 < s.length ? i + 3 : null;
	return i + 2;
}

/**
 * Finds the first line matching `pattern` in text fed in pieces. CR and LF
 * both end a line (a progress bar rewrites its line with CR). The line not
 * yet ended is tested too, on every piece, so a prompt that never prints a
 * newline still matches.
 */
export class LineMatcher {
	private tail = "";

	constructor(private readonly pattern: RegExp) {}

	feed(text: string): string | null {
		const parts = (this.tail + text).split(/\r\n|\r|\n/);
		this.tail = parts.pop() ?? "";
		for (const line of parts) if (this.test(line)) return line;
		if (this.tail && this.test(this.tail)) return this.tail;
		// Keep the open line bounded: a program that never ends a line must
		// not grow it for ever.
		if (this.tail.length > 8192) this.tail = this.tail.slice(-4096);
		return null;
	}

	private test(line: string): boolean {
		this.pattern.lastIndex = 0;
		// The match runs on the Window's main thread: bound its input.
		return this.pattern.test(
			line.length > TEST_LINE_MAX ? line.slice(0, TEST_LINE_MAX) : line,
		);
	}
}

/** Only the first this-many characters of a line are matched. */
export const TEST_LINE_MAX = 4096;

/** Whether a repetition (`*`, `+`, `{n,}`, `{n,m}` with m > 1) starts at
 *  `p[i]`. */
function repeatsAt(p: string, i: number): boolean {
	if (p[i] === "*" || p[i] === "+") return true;
	if (p[i] !== "{") return false;
	const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
	if (!m || m[2] === undefined) return false;
	return m[3] === "" || Number(m[3]) > 1;
}

/**
 * Whether the pattern repeats a group that itself repeats, like `(a+)+` or
 * `(\w*\s?)*`. Those can take exponential time on a line that almost
 * matches, and the match runs on the Window's main thread, so a slow one
 * would freeze every terminal in it. Pure.
 */
export function hasNestedRepetition(p: string): boolean {
	const outer: boolean[] = [];
	// Whether the group being read contains a repetition.
	let repeats = false;
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "\\") {
			i++;
		} else if (c === "[") {
			// A character class: its `*` and `+` are literal.
			i++;
			if (p[i] === "^") i++;
			if (p[i] === "]") i++;
			while (i < p.length && p[i] !== "]") {
				if (p[i] === "\\") i++;
				i++;
			}
		} else if (c === "(") {
			outer.push(repeats);
			repeats = false;
		} else if (c === ")") {
			const inner: boolean = repeats;
			repeats = (outer.pop() ?? false) || inner;
			if (inner && repeatsAt(p, i + 1)) return true;
		} else if (repeatsAt(p, i)) {
			repeats = true;
		}
	}
	return false;
}

/** The Agent's pattern as a regex, or null when it does not compile. */
export function compilePattern(
	pattern: string,
	ignoreCase: boolean,
): RegExp | null {
	try {
		return new RegExp(pattern, ignoreCase ? "i" : "");
	} catch {
		return null;
	}
}
