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

export function parseShellIntegration(data: Uint8Array): {
	cleaned: Uint8Array;
	commands: ShellCommand[];
} {
	const commands: ShellCommand[] = [];
	const cleanedParts: Uint8Array[] = [];
	let i = 0;
	let lastCopyEnd = 0;

	while (i < data.length) {
		if (data[i] === ESC && i + 1 < data.length && data[i + 1] === BRACKET) {
			// Potential OSC sequence starting at i
			// Check if it matches \x1b]7770;
			let matchesPrefix = true;
			for (let p = 0; p < PREFIX.length; p++) {
				if (i + 1 + p >= data.length || data[i + 1 + p] !== PREFIX[p]) {
					matchesPrefix = false;
					break;
				}
			}

			if (matchesPrefix) {
				// Find the BEL terminator
				const payloadStart = i + 1 + PREFIX.length; // after "\x1b]7770;"
				let belIndex = -1;
				for (let j = payloadStart; j < data.length; j++) {
					if (data[j] === BEL) {
						belIndex = j;
						break;
					}
				}

				if (belIndex === -1) {
					// TODO: buffer partial sequences across chunks
					// Partial sequence at end of data — keep it in cleaned output
					break;
				}

				// Extract payload string between "7770;" and BEL
				const payload = textDecoder.decode(
					data.subarray(payloadStart, belIndex),
				);

				if (
					payload === "command_start" ||
					payload.startsWith("command_start;")
				) {
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

				// Copy everything before the sequence
				if (i > lastCopyEnd) {
					cleanedParts.push(data.subarray(lastCopyEnd, i));
				}
				lastCopyEnd = belIndex + 1;
				i = belIndex + 1;
				continue;
			}
		}
		i++;
	}

	// Copy remaining data
	if (lastCopyEnd < data.length) {
		cleanedParts.push(data.subarray(lastCopyEnd));
	}

	if (commands.length === 0) {
		return { cleaned: data, commands: [] };
	}

	// Concatenate cleaned parts
	const totalLength = cleanedParts.reduce((sum, part) => sum + part.length, 0);
	const cleaned = new Uint8Array(totalLength);
	let offset = 0;
	for (const part of cleanedParts) {
		cleaned.set(part, offset);
		offset += part.length;
	}

	return { cleaned, commands };
}
