import type { PaneNode, PtyStatusType, SessionWithTabs } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";
import { X } from "../Icons";

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
	if (statuses.some((s) => s.type === "running")) return "var(--success)";
	if (statuses.some((s) => s.type === "exited" && s.code !== 0 && s.code !== null))
		return "var(--error)";
	return "var(--fg-secondary)";
}

function shortenPath(fullPath: string): string {
	const home = "/Users/";
	if (fullPath.startsWith(home)) {
		const afterHome = fullPath.slice(home.length);
		const slashIdx = afterHome.indexOf("/");
		if (slashIdx !== -1) {
			return `~${afterHome.slice(slashIdx)}`;
		}
		return "~";
	}
	return fullPath;
}

export function SessionItem({ session, isActive, onClick, onDelete }: Props) {
	const ptyStatuses = useSessionStore((s) => s.ptyStatuses);

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

	return (
		<div
			onClick={onClick}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
			className="group flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
			style={{
				backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
				borderLeft: isActive ? "2px solid var(--accent)" : "2px solid transparent",
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
			}}
			onMouseLeave={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dotColor }} />
			<div className="flex-1 min-w-0">
				<span className="truncate font-medium" style={{ color: "var(--fg-primary)", fontSize: 13 }}>
					{session.name}
				</span>
				<div className="truncate mt-0.5" style={{ color: "var(--fg-secondary)", fontSize: 11 }}>
					{shortenPath(session.rootFolder)}
				</div>
			</div>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md flex items-center justify-center hover:bg-[var(--error)] hover:text-white transition-all"
				style={{ color: "var(--fg-secondary)" }}
			>
				<X size={12} />
			</button>
		</div>
	);
}
