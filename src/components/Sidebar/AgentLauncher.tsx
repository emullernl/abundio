import { useState } from "react";
import { useAgents } from "../../hooks/useAgents";
import { Bot } from "../Icons";

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
				className="w-full rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
				style={{
					backgroundColor: "var(--bg-tertiary)",
					color: "var(--accent)",
					border: "1px solid var(--border)",
					fontSize: 13,
					height: 34,
				}}
			>
				<Bot size={14} />
				Launch Agent
			</button>

			{open && (
				<div
					className="absolute left-0 right-0 bottom-full mb-1.5 rounded-lg overflow-hidden z-50 shadow-2xl"
					style={{
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
					}}
				>
					{availableAgents.length > 0 && (
						<>
							<div className="px-3 pt-2 pb-1" style={{ fontSize: 10, color: "var(--fg-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
								Available
							</div>
							{availableAgents.map((agent) => (
								<button
									key={agent.name}
									type="button"
									onClick={() => {
										onSpawnAgent(agent.name);
										setOpen(false);
									}}
									className="w-full text-left px-3 py-2 hover:bg-[var(--bg-tertiary)] transition-colors"
									style={{ color: "var(--fg-primary)", fontSize: 13 }}
								>
									{agent.displayName}
								</button>
							))}
						</>
					)}
					{unavailableAgents.length > 0 && (
						<>
							<div className="px-3 pt-2 pb-1" style={{ fontSize: 10, color: "var(--fg-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
								Not Installed
							</div>
							{unavailableAgents.map((agent) => (
								<div
									key={agent.name}
									className="px-3 py-2"
									style={{ color: "var(--fg-secondary)", opacity: 0.4, fontSize: 13 }}
								>
									{agent.displayName}
								</div>
							))}
						</>
					)}
				</div>
			)}
		</div>
	);
}
