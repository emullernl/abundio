/**
 * Strips terminal reset/clear escape sequences from PTY output during the
 * shell startup grace period so that restored scrollback is not wiped.
 *
 * Targeted sequences:
 *  - ESC c        (0x1b 0x63)        — RIS: Reset to Initial State
 *  - ESC [ 2 J    (0x1b 0x5b 0x32 0x4a) — ED 2: Erase entire display
 *  - ESC [ 3 J    (0x1b 0x5b 0x33 0x4a) — ED 3: Erase scrollback buffer
 */
export function stripResetSequences(data: Uint8Array): Uint8Array {
	const len = data.length;
	if (len === 0) return data;

	// Fast path: scan for any ESC byte first — if none, return original
	let hasEsc = false;
	for (let i = 0; i < len; i++) {
		if (data[i] === 0x1b) {
			hasEsc = true;
			break;
		}
	}
	if (!hasEsc) return data;

	// Collect kept regions as [start, end) pairs to avoid per-byte copies
	const regions: [number, number][] = [];
	let regionStart = 0;
	let i = 0;

	while (i < len) {
		if (data[i] === 0x1b) {
			// Check for ESC c (RIS) — 2 bytes
			if (i + 1 < len && data[i + 1] === 0x63) {
				if (i > regionStart) regions.push([regionStart, i]);
				i += 2;
				regionStart = i;
				continue;
			}

			// Check for ESC [ 2 J or ESC [ 3 J — 4 bytes
			if (
				i + 3 < len &&
				data[i + 1] === 0x5b &&
				(data[i + 2] === 0x32 || data[i + 2] === 0x33) &&
				data[i + 3] === 0x4a
			) {
				if (i > regionStart) regions.push([regionStart, i]);
				i += 4;
				regionStart = i;
				continue;
			}
		}

		i++;
	}

	// Nothing was stripped — return original reference
	if (regionStart === 0 && regions.length === 0) return data;

	// Collect final region
	if (regionStart < len) regions.push([regionStart, len]);

	// Build result
	let totalLen = 0;
	for (const [s, e] of regions) totalLen += e - s;

	if (totalLen === 0) return new Uint8Array(0);

	const result = new Uint8Array(totalLen);
	let offset = 0;
	for (const [s, e] of regions) {
		result.set(data.subarray(s, e), offset);
		offset += e - s;
	}

	return result;
}
