import type { PaneNode, PtyStatusType, SessionWithTabs } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";

interface Props {
	session: SessionWithTabs;
	isActive: boolean;
	onClick: () => void;
	onDelete: () => void;
}

function collectPtyIds(node: PaneNode): string[] {
	if (node.type === "terminal") return node.ptyId ? [node.ptyId] : [];
	return [...collectPtyIds(node.first), ...collectPtyIds(node.second)];
}

function statusColor(statuses: PtyStatusType[]): string {
	if (statuses.length === 0) return "var(--fg-secondary)"; // no panes
	// If any are running, show green
	if (statuses.some((s) => s.type === "running")) return "var(--success)";
	// If any exited with error, show red
	if (statuses.some((s) => s.type === "exited" && s.code !== 0 && s.code !== null))
		return "var(--error)";
	// All exited cleanly
	return "var(--fg-secondary)";
}

export function SessionItem({ session, isActive, onClick, onDelete }: Props) {
	const ptyStatuses = useSessionStore((s) => s.ptyStatuses);

	// Collect pty IDs across all tabs
	const allPtyIds: string[] = [];
	for (const tab of session.tabs) {
		try {
			const layout = JSON.parse(tab.layoutJson) as PaneNode;
			allPtyIds.push(...collectPtyIds(layout));
		} catch {
			// ignore
		}
	}
	const paneStatuses = allPtyIds.map((id) => ptyStatuses[id]).filter(Boolean);

	const dotColor = statusColor(paneStatuses);
	const runningCount = paneStatuses.filter((s) => s.type === "running").length;

	return (
		<div
			onClick={onClick}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
			className="group flex items-center gap-3 px-3.5 py-3 rounded-lg cursor-pointer transition-colors"
			style={{
				backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
			}}
			onMouseLeave={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<span className="truncate font-medium" style={{ color: "var(--fg-primary)", fontSize: 14 }}>
						{session.name}
					</span>
					{runningCount > 0 && (
						<span
							className="flex-shrink-0 rounded-full px-1.5"
							style={{ fontSize: 11, color: "var(--fg-secondary)", backgroundColor: "var(--bg-tertiary)" }}
						>
							{runningCount}
						</span>
					)}
				</div>
				<div className="truncate mt-0.5" style={{ color: "var(--fg-secondary)", fontSize: 12 }}>
					{session.rootFolder}
				</div>
			</div>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-md flex items-center justify-center hover:bg-[var(--error)] hover:text-white transition-all"
				style={{ color: "var(--fg-secondary)", fontSize: 13 }}
			>
				&times;
			</button>
		</div>
	);
}
