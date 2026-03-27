import { useState } from "react";
import { useAgents } from "../../hooks/useAgents";

interface Props {
	onSpawnAgent: (agentName: string) => void;
}

export function AgentLauncher({ onSpawnAgent }: Props) {
	const { agents, loading } = useAgents();
	const [open, setOpen] = useState(false);

	if (loading) return null;

	const availableAgents = agents.filter((a) => a.available);
	const unavailableAgents = agents.filter((a) => !a.available);

	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="w-full px-4 py-2 text-sm rounded-lg transition-colors"
				style={{
					backgroundColor: "var(--bg-tertiary)",
					color: "var(--accent)",
					border: "1px solid var(--border)",
				}}
			>
				Launch Agent
			</button>

			{open && (
				<div
					className="absolute left-0 right-0 bottom-full mb-1 rounded-lg overflow-hidden z-50 shadow-lg"
					style={{
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
					}}
				>
					{availableAgents.map((agent) => (
						<button
							key={agent.name}
							type="button"
							onClick={() => {
								onSpawnAgent(agent.name);
								setOpen(false);
							}}
							className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
							style={{ color: "var(--fg-primary)" }}
						>
							{agent.displayName}
						</button>
					))}
					{unavailableAgents.map((agent) => (
						<div
							key={agent.name}
							className="px-3 py-2 text-sm"
							style={{ color: "var(--fg-secondary)", opacity: 0.5 }}
						>
							{agent.displayName} — not installed
						</div>
					))}
				</div>
			)}
		</div>
	);
}
