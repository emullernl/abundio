/** The default name for a new Tab: "Tab N", where N is the lowest number not
 *  already taken by a Tab in the Workspace named exactly "Tab <N>" — whoever
 *  gave it that name. Older "Terminal N" names do not count. */
export function nextTabName(existingNames: readonly string[]): string {
	const taken = new Set<number>();
	for (const name of existingNames) {
		const match = /^Tab ([1-9]\d*)$/.exec(name);
		if (match) taken.add(Number(match[1]));
	}
	let n = 1;
	while (taken.has(n)) n++;
	return `Tab ${n}`;
}

/** The name of a Workspace's first Tab. Rust uses the same literal. */
export const FIRST_TAB_NAME = "Tab 1";
