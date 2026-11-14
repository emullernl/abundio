import { useWindowUiStore } from "../../stores/windowUiStore";

/**
 * The **Orchestrator view** (ADR-0057): the Window's third view, beside the
 * Workspace view and the Fleet Console. Orchestrator tabs across the top (the
 * graph first), the Orchestrator workspace's panes below, always visible.
 * Replaces everything between the Overview bar and the Status bar, like the
 * Fleet Console, and sits under the Statistics overlay.
 */
export function OrchestratorView({ topOffset }: { topOffset: number }) {
	const open = useWindowUiStore((s) => s.orchestratorViewOpen);
	if (!open) return null;
	return <OrchestratorViewBody topOffset={topOffset} />;
}

function OrchestratorViewBody({ topOffset }: { topOffset: number }) {
	return (
		<div
			data-orchestrator-view
			className="absolute flex flex-col"
			style={{
				top: topOffset,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 25,
				background: "var(--ambient-glow-top), var(--bg-primary)",
			}}
		>
			<div
				className="flex items-center justify-center flex-1 min-h-0 select-none text-[var(--fg-secondary)]"
				style={{ fontSize: 13 }}
			>
				Orchestrator
			</div>
		</div>
	);
}
