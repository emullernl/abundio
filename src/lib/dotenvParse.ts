// Parser for pasted `.env` content, used by the Environment Bundle import
// dialog. Pure and testable — no IPC, no DOM.
//
// This is deliberately a *tolerant reader* of the common `.env` dialects
// (docker compose, dotenv, `export`-prefixed shell snippets) rather than a
// strict implementation of any one of them. People paste whatever their team's
// file happens to contain, and a rejected paste is worse than a slightly
// generous one. Anything that fails validation is reported, never silently
// dropped.

/** Variable names Abundio accepts: POSIX shell identifiers. Mirrors
 *  `env_crypto::validate_name` in Rust, which is the real enforcement point —
 *  this copy only drives the preview so the user sees problems before writing. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names Abundio owns. Mirrors `env_crypto::RESERVED_NAMES` / prefix check. */
const RESERVED_PREFIX = "ABUNDIO_";
const RESERVED_NAMES = new Set([
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"PROMPT_EOL_MARK",
	"ZDOTDIR",
	"CHERE_INVOKING",
]);

export interface ParsedEnvEntry {
	name: string;
	value: string;
}

export interface DotenvParseResult {
	/** Valid entries, duplicates collapsed with last-wins. */
	entries: ParsedEnvEntry[];
	/** Names that are not valid identifiers or are reserved by Abundio. */
	invalidNames: string[];
	/** Non-empty, non-comment lines that had no `=` at all. */
	skippedLines: number;
	/** Names whose quoted value ran to the end of the file with no closing
	 *  quote. Reported rather than imported: a truncated certificate is far
	 *  worse than a refused import. */
	unterminated: string[];
}

/** Mirrors `env_crypto::SHADOW_PREFIX`. */
const SHADOW_PREFIX = "ABUNDIO_ENV__";

/**
 * Bytes one variable adds to a spawned shell's environment block.
 *
 * Mirrors `env_crypto::injection_cost` in Rust, which is the enforcement point;
 * this copy exists so the Add form can predict a rejection instead of letting
 * `build_env_injection` drop the variable later with only a log line. Kept next
 * to `isValidEnvName`, which mirrors `validate_name` for the same reason.
 */
export function injectionCost(nameLength: number, valueLength: number): number {
	return (
		(nameLength + valueLength + 2) * 2 + SHADOW_PREFIX.length + nameLength + 1
	);
}

export function isValidEnvName(name: string): boolean {
	if (!IDENTIFIER.test(name)) return false;
	const upper = name.toUpperCase();
	return !upper.startsWith(RESERVED_PREFIX) && !RESERVED_NAMES.has(upper);
}

/**
 * Parse pasted `.env` text.
 *
 * Rules:
 *  - `export FOO=bar` — the `export ` prefix is stripped.
 *  - Split on the FIRST `=`; later ones belong to the value (URLs, base64).
 *  - A value wrapped in matching `"` or `'` is unwrapped. Only double quotes
 *    interpret `\n`, `\r`, `\t` and `\\` — single quotes are literal, matching
 *    shell and dotenv behaviour.
 *  - Whole-line `#` comments and blank lines are ignored. A `#` inside a value
 *    is NOT a comment: too many real tokens and URLs contain one, and guessing
 *    wrong would silently truncate a secret.
 *  - A value that opens with `"` or `'` and does not close on the same line
 *    continues across lines until the matching quote. This is the flagship
 *    case — a PEM certificate in a `.env` is written exactly that way, and
 *    treating it line-at-a-time silently imported a truncated secret.
 *  - CRLF is tolerated.
 *  - Duplicate names: last wins, matching how a shell would evaluate the file.
 */
export function parseDotenv(text: string): DotenvParseResult {
	const byName = new Map<string, string>();
	const invalidNames: string[] = [];
	const unterminated: string[] = [];
	let skippedLines = 0;

	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("#")) continue;

		const withoutExport = line.startsWith("export ")
			? line.slice("export ".length).trim()
			: line;

		const eq = withoutExport.indexOf("=");
		if (eq === -1) {
			skippedLines++;
			continue;
		}

		const name = withoutExport.slice(0, eq).trim();
		let rawValue = withoutExport.slice(eq + 1).trim();

		// A quoted value that does not close on this line continues until the
		// matching quote. Newlines inside it are part of the value — this is how
		// certificates and private keys appear in a real `.env`.
		const quote = rawValue[0];
		if (
			(quote === '"' || quote === "'") &&
			!closesOnSameLine(rawValue, quote)
		) {
			const collected = [rawValue];
			let closed = false;
			while (++i < lines.length) {
				const next = lines[i];
				collected.push(next);
				if (next.includes(quote)) {
					closed = true;
					break;
				}
			}
			if (!closed) {
				// Refuse rather than import a value cut off at end-of-file.
				if (isValidEnvName(name) && !unterminated.includes(name)) {
					unterminated.push(name);
				}
				continue;
			}
			rawValue = collected.join("\n").trimEnd();
		}

		const value = unquote(rawValue);

		if (!isValidEnvName(name)) {
			if (!invalidNames.includes(name)) invalidNames.push(name);
			continue;
		}
		byName.set(name, value);
	}

	return {
		entries: [...byName].map(([name, value]) => ({ name, value })),
		invalidNames,
		skippedLines,
		unterminated,
	};
}

/** Whether a value opening with `quote` also closes on the same line. The
 *  opening character is skipped, and an escaped quote does not count. */
function closesOnSameLine(rawValue: string, quote: string): boolean {
	for (let i = 1; i < rawValue.length; i++) {
		if (rawValue[i] === "\\") {
			i++;
			continue;
		}
		if (rawValue[i] === quote) return true;
	}
	return false;
}

function unquote(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0];
		const last = raw[raw.length - 1];
		if (first === '"' && last === '"') {
			// Single pass, not a chain of replaces. Replacing `\n` before `\\`
			// decodes a LITERAL backslash-n (as in a Windows path, or anything
			// `abundio-env print` emitted) into a real newline — the Rust side
			// escapes the backslash first, so a chained decode does not
			// round-trip.
			return raw.slice(1, -1).replace(/\\(.)/g, (_match, ch: string) => {
				switch (ch) {
					case "n":
						return "\n";
					case "r":
						return "\r";
					case "t":
						return "\t";
					case "\\":
						return "\\";
					case '"':
						return '"';
					default:
						// Unknown escape: keep it verbatim rather than eating the
						// backslash.
						return `\\${ch}`;
				}
			});
		}
		if (first === "'" && last === "'") {
			// Single quotes are literal — no escape processing.
			return raw.slice(1, -1);
		}
	}
	return raw;
}
