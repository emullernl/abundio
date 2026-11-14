// **Handle order**: the order of the **Agents list** and the **Agent cycle**.
// By **Agent handle**, ignoring case; **Default handles** ("Agent Two") by
// their number, where "Agent" falls alphabetically. Pure.

import { handleKey } from "./agentHandle";

const ONES = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
	"thirteen",
	"fourteen",
	"fifteen",
	"sixteen",
	"seventeen",
	"eighteen",
	"nineteen",
];
const TENS = [
	"",
	"",
	"twenty",
	"thirty",
	"forty",
	"fifty",
	"sixty",
	"seventy",
	"eighty",
	"ninety",
];

/** `n` in words, as Rust's `agent_names::number_words` spells it, lowercase. */
function numberWords(n: number): string {
	if (n < 20) return ONES[n];
	if (n < 100)
		return n % 10 ? `${TENS[(n / 10) | 0]}-${ONES[n % 10]}` : TENS[n / 10];
	const rest = n % 100;
	const hundreds = `${ONES[(n / 100) | 0]} hundred`;
	return rest ? `${hundreds} ${numberWords(rest)}` : hundreds;
}

let byKey: Map<string, number> | null = null;

/** The number of a **Default handle** ("Agent Twenty-One" → 21), or null when
 *  `handle` is not one. Matched by `handleKey`, so case and dashes do not
 *  matter. Rust spells numbers as words up to 999, which covers any Profile. */
export function defaultHandleNumber(handle: string): number | null {
	if (!byKey) {
		byKey = new Map();
		for (let n = 1; n <= 999; n++) {
			byKey.set(handleKey(`agent ${numberWords(n)}`), n);
		}
	}
	return byKey.get(handleKey(handle)) ?? null;
}

/** Compare two handles in Handle order. */
export function compareHandles(a: string, b: string): number {
	const na = defaultHandleNumber(a);
	const nb = defaultHandleNumber(b);
	const byText = (na === null ? a : "Agent").localeCompare(
		nb === null ? b : "Agent",
		"en",
		{ sensitivity: "base", numeric: true },
	);
	if (byText !== 0) return byText;
	if (na !== null && nb !== null) return na - nb;
	// A custom handle that reads "Agent" before the Default handles.
	if (na !== null) return 1;
	if (nb !== null) return -1;
	return 0;
}

/**
 * `items` in Handle order. Items without a handle yet (a pane that has just
 * entered agent mode) go last. Ties keep their input order, so feeding the
 * Fleet Console's derived order keeps the list stable.
 */
export function sortByHandle<T>(
	items: readonly T[],
	handleOf: (item: T) => string | undefined,
): T[] {
	return items
		.map((item, i) => ({ item, i, handle: handleOf(item) }))
		.sort((x, y) => {
			if (x.handle === undefined || y.handle === undefined) {
				if (x.handle !== y.handle) return x.handle === undefined ? 1 : -1;
				return x.i - y.i;
			}
			return compareHandles(x.handle, y.handle) || x.i - y.i;
		})
		.map((x) => x.item);
}
