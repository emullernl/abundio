export interface ShellCommand {
	type: "command_start" | "command_end" | "cwd_change";
	exitCode?: number;
	commandText?: string;
	path?: string;
}

const ESC = 0x1b;
const BEL = 0x07;
const BRACKET = 0x5d; // ']'

const PREFIX = new TextEncoder().encode("]7770;");
const textDecoder = new TextDecoder();

/**
 * Maximum bytes we'll buffer waiting for an OSC terminator. Shell-integration
 * payloads are short (`cwd;<path>`, `command_start;<cmd>`, etc.) so anything
 * past this is almost certainly a misframed sequence that will never terminate
 * — flush it as plain bytes to avoid an unbounded buffer.
 */
const MAX_PARTIAL = 16 * 1024;

/**
 * Per-stream parser state. The previous implementation was stateless and
 * dropped events whenever a sequence straddled a chunk boundary; worse, if the
 * boundary fell inside the `]7770;` prefix the partial bytes were forwarded to
 * xterm, which could briefly render them as visible text before the rest
 * arrived. Callers should keep one Parser per PTY.
 */
export class ShellIntegrationParser {
	/** Bytes held over from the previous chunk because they look like the
	 *  start (or partial body) of an OSC sequence whose terminator we haven't
	 *  seen yet. Prepended to the next chunk before scanning. */
	private residual: Uint8Array | null = null;

	parse(data: Uint8Array): {
		cleaned: Uint8Array;
		commands: ShellCommand[];
	} {
		// Fast path: no residual carrying state from the previous chunk and no
		// ESC byte in this chunk → nothing to scan, return the original buffer
		// reference so the call is allocation-free for the common case.
		if (!this.residual) {
			let hasEsc = false;
			for (let k = 0; k < data.length; k++) {
				if (data[k] === ESC) {
					hasEsc = true;
					break;
				}
			}
			if (!hasEsc) return { cleaned: data, commands: [] };
		}

		const input = this.residual ? concat(this.residual, data) : data;
		this.residual = null;

		const commands: ShellCommand[] = [];
		const cleanedParts: Uint8Array[] = [];
		let i = 0;
		let lastCopyEnd = 0;

		while (i < input.length) {
			if (input[i] !== ESC) {
				i++;
				continue;
			}
			// `\x1b]` could be the start of OUR sequence (`\x1b]7770;…`) or
			// of any other OSC the shell emits (e.g. xterm window title sets,
			// OSC 8 hyperlinks). We have to distinguish:
			//   1. Prefix match incomplete (chunk ends mid-`]7770;`) → buffer.
			//   2. Prefix matches `]7770;` but no BEL yet → buffer.
			//   3. Prefix matches and BEL found → strip and emit command.
			//   4. ESC ] followed by a different OSC code → leave for xterm.
			//
			// (1) and (2) prevent the partial OSC from ever reaching xterm
			// while we wait for the rest, which is what kills the visible-
			// flicker / typing-eaten regression.
			if (i + 1 >= input.length) {
				this.residual = input.subarray(i);
				break;
			}
			if (input[i + 1] !== BRACKET) {
				i++;
				continue;
			}

			// Check prefix \x1b]7770; — partial = buffer, mismatch = pass through.
			let prefixPartial = false;
			let prefixMatch = true;
			for (let p = 0; p < PREFIX.length; p++) {
				const idx = i + 1 + p;
				if (idx >= input.length) {
					prefixPartial = true;
					prefixMatch = false;
					break;
				}
				if (input[idx] !== PREFIX[p]) {
					prefixMatch = false;
					break;
				}
			}

			if (prefixPartial) {
				// Hold the partial ESC] sequence for the next chunk so xterm
				// doesn't get a chance to render it as text.
				this.residual = input.subarray(i);
				break;
			}
			if (!prefixMatch) {
				// Some other OSC (or random `\x1b]X…`) — xterm handles it.
				i++;
				continue;
			}

			const payloadStart = i + 1 + PREFIX.length;
			let belIndex = -1;
			for (let j = payloadStart; j < input.length; j++) {
				if (input[j] === BEL) {
					belIndex = j;
					break;
				}
			}

			if (belIndex === -1) {
				// Full prefix, no terminator yet. Hold from `i` onward and
				// wait — unless the residual is already pathologically large,
				// in which case bail and flush as bytes.
				const partial = input.subarray(i);
				if (partial.length > MAX_PARTIAL) {
					// Give up and let xterm see the bytes; preserve correctness
					// over completeness for misframed input.
					i++;
					continue;
				}
				this.residual = partial;
				break;
			}

			// Full sequence; strip and emit.
			const payload = textDecoder.decode(
				input.subarray(payloadStart, belIndex),
			);
			if (payload === "command_start" || payload.startsWith("command_start;")) {
				const text =
					payload.length > "command_start;".length
						? payload.slice("command_start;".length)
						: undefined;
				commands.push({ type: "command_start", commandText: text });
			} else if (payload.startsWith("command_end;")) {
				const codeStr = payload.slice("command_end;".length);
				const parsed = Number.parseInt(codeStr, 10);
				commands.push({
					type: "command_end",
					exitCode: Number.isNaN(parsed) ? undefined : parsed,
				});
			} else if (payload.startsWith("cwd;")) {
				commands.push({
					type: "cwd_change",
					path: payload.slice("cwd;".length),
				});
			}

			if (i > lastCopyEnd) {
				cleanedParts.push(input.subarray(lastCopyEnd, i));
			}
			lastCopyEnd = belIndex + 1;
			i = belIndex + 1;
		}

		// Everything from lastCopyEnd up to the residual boundary is clean.
		const cleanEnd = this.residual
			? input.length - this.residual.length
			: input.length;
		if (lastCopyEnd < cleanEnd) {
			cleanedParts.push(input.subarray(lastCopyEnd, cleanEnd));
		}

		if (cleanedParts.length === 0) {
			return { cleaned: EMPTY, commands };
		}
		if (cleanedParts.length === 1 && commands.length === 0 && !this.residual) {
			// Hot path for the common "no sequences and we returned the
			// original buffer" case — avoid the alloc + copy.
			return { cleaned: cleanedParts[0], commands };
		}
		const totalLength = cleanedParts.reduce(
			(sum, part) => sum + part.length,
			0,
		);
		const cleaned = new Uint8Array(totalLength);
		let offset = 0;
		for (const part of cleanedParts) {
			cleaned.set(part, offset);
			offset += part.length;
		}
		return { cleaned, commands };
	}

	/** Reset state — call when the underlying PTY is replaced. */
	reset(): void {
		this.residual = null;
	}
}

const EMPTY = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/**
 * Stateless wrapper kept for backward compatibility with callers that don't
 * yet hold a per-stream Parser. New code should prefer `ShellIntegrationParser`
 * and a per-PTY instance so that sequences split across chunks are correctly
 * reassembled. This wrapper allocates a fresh parser per call, so it loses
 * cross-chunk state by definition.
 */
export function parseShellIntegration(data: Uint8Array): {
	cleaned: Uint8Array;
	commands: ShellCommand[];
} {
	return new ShellIntegrationParser().parse(data);
}
