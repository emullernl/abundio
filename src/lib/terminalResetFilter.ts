/**
 * Strips terminal reset/clear/positioning escape sequences (and padding CRLF
 * runs) from PTY output during the shell startup grace period so that
 * restored scrollback is not wiped and the first prompt is not pinned to
 * the bottom of the viewport.
 *
 * Targeted sequences:
 *  - ESC c                    — RIS: Reset to Initial State
 *  - CSI [<params>] H         — CUP: Cursor Position (bare home and
 *                               parameterized variants like `ESC[30;1H`)
 *  - CSI [<params>] f         — HVP: Horizontal & Vertical Position (CUP twin)
 *  - CSI 2 J                  — ED 2: Erase entire display
 *  - CSI 3 J                  — ED 3: Erase scrollback buffer
 *  - Runs of 3+ consecutive CRLF (`\r\n\r\n\r\n…`) — ConPTY (Git Bash /
 *    mintty) "paints" a blank screen by emitting N CRLFs to fill the
 *    viewport height. Left alone, these scroll the viewport down and
 *    push the first prompt to the bottom row.
 *
 * Other CSI sequences (SGR, ED 0/1, non-H/f cursor ops, etc.) and ordinary
 * single/double blank lines are preserved. Partial sequences at the end of
 * the buffer are left untouched as literal bytes — this filter is stateless
 * across chunks.
 */
export function stripResetSequences(data: Uint8Array): Uint8Array {
	const len = data.length;
	if (len === 0) return data;

	// Fast path: if the buffer has no ESC and no CR bytes, there's nothing
	// for us to strip — return the original reference.
	let hasTrigger = false;
	for (let i = 0; i < len; i++) {
		const b = data[i];
		if (b === 0x1b || b === 0x0d) {
			hasTrigger = true;
			break;
		}
	}
	if (!hasTrigger) return data;

	// Collect kept regions as [start, end) pairs to avoid per-byte copies
	const regions: [number, number][] = [];
	let regionStart = 0;
	let i = 0;

	while (i < len) {
		if (data[i] === 0x1b) {
			// ESC c (RIS) — 2 bytes
			if (i + 1 < len && data[i + 1] === 0x63) {
				if (i > regionStart) regions.push([regionStart, i]);
				i += 2;
				regionStart = i;
				continue;
			}

			// CSI: ESC [ <params> <final>
			// params = run of digits (0x30–0x39) and ';' (0x3b)
			// final  = single byte in 0x40–0x7e
			if (i + 1 < len && data[i + 1] === 0x5b) {
				let j = i + 2;
				while (j < len) {
					const b = data[j];
					if ((b >= 0x30 && b <= 0x39) || b === 0x3b) {
						j++;
					} else {
						break;
					}
				}
				if (j < len) {
					const final = data[j];
					const paramsStart = i + 2;
					const paramsLen = j - paramsStart;
					let strip = false;

					// CUP / HVP — strip all forms (bare home and parameterized)
					if (final === 0x48 /* H */ || final === 0x66 /* f */) {
						strip = true;
					}
					// ED — only strip "erase entire display" (2) and
					// "erase scrollback" (3). Preserve ED 0 / ED 1.
					else if (final === 0x4a /* J */ && paramsLen === 1) {
						const p = data[paramsStart];
						if (p === 0x32 /* '2' */ || p === 0x33 /* '3' */) {
							strip = true;
						}
					}

					if (strip) {
						if (i > regionStart) regions.push([regionStart, i]);
						i = j + 1;
						regionStart = i;
						continue;
					}
				}
			}
		}

		// Run of 3+ CRLF pairs — ConPTY viewport padding. A single or double
		// CRLF is preserved (legitimate blank-line output). Three or more in
		// a row is a screen-paint artifact and gets stripped entirely.
		if (data[i] === 0x0d && i + 1 < len && data[i + 1] === 0x0a) {
			let k = i;
			let pairs = 0;
			while (
				k + 1 < len &&
				data[k] === 0x0d &&
				data[k + 1] === 0x0a
			) {
				pairs++;
				k += 2;
			}
			if (pairs >= 3) {
				if (i > regionStart) regions.push([regionStart, i]);
				i = k;
				regionStart = i;
				continue;
			}
			// Not a padding run — skip past the pairs we counted so we don't
			// re-scan them byte-by-byte.
			i = k;
			continue;
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
