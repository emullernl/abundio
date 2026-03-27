import { useCallback, useEffect, useState } from "react";
import { agents } from "../lib/ipc";
import type { AgentInfo } from "../lib/types";

export function useAgents() {
	const [agentList, setAgentList] = useState<AgentInfo[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		agents.listAvailable().then((list) => {
			setAgentList(list);
			setLoading(false);
		});
	}, []);

	const refresh = useCallback(async () => {
		await agents.refresh();
		const list = await agents.listAvailable();
		setAgentList(list);
	}, []);

	return { agents: agentList, loading, refresh };
}
