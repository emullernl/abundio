// `abundio agent send-keys`: logical key names → the bytes a terminal sends.
// Rust has already checked every name (`valid_key`), and nothing is written
// unless all of them map, so a typo never sends half a sequence.

const FIXED: Record<string, string> = {
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	"shift+tab": "\x1b[Z",
	backspace: "\x7f",
	delete: "\x1b[3~",
	space: " ",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
};

/** Arrow, Home and End keys: `ESC O x` when the program has turned on
 *  application cursor keys (DECCKM, as most TUIs do), `ESC [ x` otherwise,
 *  the same as xterm sends for a real key press. */
const CURSOR: Record<string, string> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
	home: "H",
	end: "F",
};

export function keyBytes(name: string, appCursor: boolean): string | null {
	const fixed = FIXED[name];
	if (fixed !== undefined) return fixed;
	const cursor = CURSOR[name];
	if (cursor !== undefined) return `${appCursor ? "\x1bO" : "\x1b["}${cursor}`;
	const ctrl = /^ctrl\+([a-z])$/.exec(name);
	if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
	return null;
}

/** All the keys' bytes joined, or the first unknown name. */
export function keysToBytes(
	names: readonly string[],
	appCursor: boolean,
): { ok: true; bytes: string } | { ok: false; unknown: string } {
	let bytes = "";
	for (const name of names) {
		const b = keyBytes(name, appCursor);
		if (b === null) return { ok: false, unknown: name };
		bytes += b;
	}
	return { ok: true, bytes };
}
