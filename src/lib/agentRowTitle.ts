/**
 * The first-line text of an **Agent row**: the Agent's **Agent handle** when
 * it has one, then the title the Agent gives its own terminal, or the Agent's
 * name when it has set none.
 */
export function agentRowTitle({
	agentName,
	xtermTitle,
	handle,
}: {
	agentName: string;
	xtermTitle: string;
	handle?: string;
}): string {
	const title = xtermTitle.trim() || agentName;
	return handle ? `${handle} · ${title}` : title;
}
