/**
 * The title the Agent gives its own terminal, or the Agent's name when it has
 * set none. An **Agent row**'s second line (when no Progress line is set), and
 * the Navigator's label for an Agent pane.
 */
export function agentRowTitle({
	agentName,
	xtermTitle,
}: {
	agentName: string;
	xtermTitle: string;
}): string {
	return xtermTitle.trim() || agentName;
}

export interface AgentRowText {
	/** First line: the **Agent handle**, or the Agent's name until it has one. */
	primary: string;
	/** Second line: the **Progress line**, else the terminal title, else the
	 *  Agent's name. */
	secondary: string;
	/** Where the Agent is: Workspace and Tab. The flat list's third line. */
	location: string;
	/** Location first, then what the row may not show in full. */
	tooltip: string;
}

/** Everything an **Agent row** writes, from its pane's values. */
export function agentRowText({
	agentName,
	xtermTitle,
	handle,
	progress,
	flagMessage,
	workspaceName,
	tabName,
}: {
	agentName: string;
	xtermTitle: string;
	handle?: string;
	progress?: string;
	flagMessage?: string;
	workspaceName: string;
	tabName: string;
}): AgentRowText {
	const title = xtermTitle.trim();
	const primary = handle || agentName;
	const secondary = progress || title || agentName;
	// A Workspace not in the store yet (mid-load) has no name: show the Tab alone.
	const location = workspaceName ? `${workspaceName} · ${tabName}` : tabName;
	const tooltip = [
		workspaceName
			? `Workspace ${workspaceName} · Tab ${tabName}`
			: `Tab ${tabName}`,
		// The name only when neither line already shows it.
		primary === agentName || secondary === agentName ? "" : agentName,
		title,
		progress || "",
		flagMessage ? `Wants your attention: ${flagMessage}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return { primary, secondary, location, tooltip };
}
