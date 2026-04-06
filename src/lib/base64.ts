// Lookup-table base64 decoder — ~3-8x faster than atob() + charCodeAt() loop.
// The table is built once at module load; decode iterates 4 chars at a time,
// packing 3 output bytes with no intermediate string allocation.

const B64_LOOKUP = new Uint8Array(128);
const B64_CHARS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let i = 0; i < B64_CHARS.length; i++) {
	B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function decodeBase64(str: string): Uint8Array {
	let len = str.length;
	if (len === 0) return new Uint8Array(0);

	// Count trailing '=' padding
	let padding = 0;
	if (str.charCodeAt(len - 1) === 0x3d) padding++;
	if (str.charCodeAt(len - 2) === 0x3d) padding++;

	const outLen = (len * 3) / 4 - padding;
	const out = new Uint8Array(outLen);
	let j = 0;

	// Process 4 input chars → 3 output bytes
	for (let i = 0; i < len; i += 4) {
		const a = B64_LOOKUP[str.charCodeAt(i)];
		const b = B64_LOOKUP[str.charCodeAt(i + 1)];
		const c = B64_LOOKUP[str.charCodeAt(i + 2)];
		const d = B64_LOOKUP[str.charCodeAt(i + 3)];

		out[j++] = (a << 2) | (b >> 4);
		if (j < outLen) out[j++] = ((b & 0x0f) << 4) | (c >> 2);
		if (j < outLen) out[j++] = ((c & 0x03) << 6) | d;
	}

	return out;
}
