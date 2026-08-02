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
 *  - CRLF is tolerated.
 *  - Duplicate names: last wins, matching how a shell would evaluate the file.
 */
export function parseDotenv(text: string): DotenvParseResult {
	const byName = new Map<string, string>();
	const invalidNames: string[] = [];
	let skippedLines = 0;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
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
		const value = unquote(withoutExport.slice(eq + 1).trim());

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
	};
}

function unquote(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0];
		const last = raw[raw.length - 1];
		if (first === '"' && last === '"') {
			return raw
				.slice(1, -1)
				.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\\\/g, "\\")
				.replace(/\\"/g, '"');
		}
		if (first === "'" && last === "'") {
			// Single quotes are literal — no escape processing.
			return raw.slice(1, -1);
		}
	}
	return raw;
}
