/**
 * The first-line text of an **Agent row**: the title the Agent gives its own
 * terminal, or the Agent's name when it has set none.
 */
export function agentRowTitle({
	agentName,
	xtermTitle,
}: {
	agentName: string;
	xtermTitle: string;
}): string {
	const title = xtermTitle.trim();
	return title || agentName;
}
