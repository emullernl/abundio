import type { CodingAgent } from "./types";

/** The custom Agents of `source` a Host does not have yet (same name and
 *  command), ready to add to it under new ids (ADR-0064, "Copy from…"). */
export function copyableAgents(
	source: CodingAgent[],
	have: CodingAgent[],
): CodingAgent[] {
	const key = (a: CodingAgent) => `${a.name}\u0000${a.command}`;
	const present = new Set(have.map(key));
	return source.filter((a) => !a.builtin && !present.has(key(a)));
}

/** A copy for another Host: its own id, switched on. */
export function copyOf(a: CodingAgent): CodingAgent {
	return {
		...a,
		id: `custom-${crypto.randomUUID()}`,
		enabled: true,
		retiredBuiltin: undefined,
	};
}
