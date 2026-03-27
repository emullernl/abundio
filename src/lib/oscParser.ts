export interface ShellMeta {
	cwd: string;
	git: string;
	user: string;
	exit: number;
	elapsed: string;
}

export interface ProcessedOutput {
	cleaned: Uint8Array;
	meta: ShellMeta | null;
	altScreen: "enter" | "exit" | null;
}

// Alternate screen: \x1b[?1049h (enter) and \x1b[?1049l (exit)
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

/**
 * Processes raw PTY output, extracting custom OSC 7337 sequences
 * and detecting alternate screen mode transitions.
 */
export function processOutput(data: Uint8Array): ProcessedOutput {
	let meta: ShellMeta | null = null;
	let altScreen: "enter" | "exit" | null = null;

	// Convert to string for pattern matching (OSC sequences are ASCII)
	const text = new TextDecoder("latin1").decode(data);

	// Detect alternate screen transitions
	if (text.includes(ALT_SCREEN_ENTER)) {
		altScreen = "enter";
	} else if (text.includes(ALT_SCREEN_EXIT)) {
		altScreen = "exit";
	}

	// Strip init-begin markers (OSC 7338)
	let cleaned = text.replace(/\x1b\]7338;[^\x07]*\x07/g, "");

	// Find and extract OSC 7337 sequences
	const oscRegex = /\x1b\]7337;([^\x07]*)\x07/g;
	let match: RegExpExecArray | null;

	while ((match = oscRegex.exec(text)) !== null) {
		try {
			const json = match[1];
			meta = JSON.parse(json) as ShellMeta;
		} catch {
			// Malformed JSON — ignore
		}
		// Strip the OSC sequence from output
		cleaned = cleaned.replace(match[0], "");
	}

	// Convert back to Uint8Array
	const encoder = new TextEncoder();
	const cleanedBytes = encoder.encode(cleaned);

	return { cleaned: cleanedBytes, meta, altScreen };
}
