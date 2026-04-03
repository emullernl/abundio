import { useMemo } from "react";
import type { PaneNode, SessionWithTabs } from "../../lib/types";
import type { DotStatus } from "../../stores/ptyActivityStore";
import {
	computeSessionDotStatus,
	DOT_COLORS,
	DOT_GLOWS,
	shouldPulse,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { X } from "../Icons";

interface Props {
	session: SessionWithTabs;
	isActive: boolean;
	isDragging: boolean;
	onClick: () => void;
	onDelete: () => void;
	onMouseDown: (e: React.MouseEvent) => void;
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

function useSessionDotStatus(session: SessionWithTabs): DotStatus {
	const tabLayouts = useMemo(() => {
		const layouts: PaneNode[] = [];
		for (const tab of session.tabs) {
			try {
				layouts.push(JSON.parse(tab.layoutJson) as PaneNode);
			} catch {
				// ignore
			}
		}
		return layouts;
	}, [session.tabs]);

	return usePtyActivityStore((s) => {
		return computeSessionDotStatus(
			session.id,
			tabLayouts,
			s.activities,
			s.openedSessionIds,
			s.panePtyMap,
		);
	});
}

export function SessionItem({
	session,
	isActive,
	isDragging,
	onClick,
	onDelete,
	onMouseDown,
}: Props) {
	const dotStatus = useSessionDotStatus(session);
	const dotColor = DOT_COLORS[dotStatus];
	const pulse = shouldPulse(dotStatus);

	return (
		// biome-ignore lint/a11y/useSemanticElements: div used intentionally for styling
		<div
			role="button"
			tabIndex={0}
			onMouseDown={onMouseDown}
			onClick={onClick}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
			className="group flex items-center gap-2.5 pr-3 py-2.5 rounded-lg cursor-pointer transition-colors"
			style={{
				paddingLeft: 20,
				backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
				borderLeft: isActive
					? "2px solid var(--accent)"
					: "2px solid transparent",
				opacity: isDragging ? 0.4 : 1,
				transitionDuration: "var(--transition-fast)",
			}}
			onMouseEnter={(e) => {
				if (!isActive)
					e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
			}}
			onMouseLeave={(e) => {
				if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<div
				className={`w-2 h-2 rounded-full flex-shrink-0 ${pulse ? "status-dot-pulse" : ""}`}
				style={
					{
						backgroundColor: dotColor,
						"--dot-glow": DOT_GLOWS[dotStatus] ?? "transparent",
					} as React.CSSProperties
				}
			/>
			<div className="flex-1 min-w-0">
				<span
					className="truncate font-medium"
					style={{ color: "var(--fg-primary)", fontSize: 13 }}
				>
					{session.name}
				</span>
				<div
					className="truncate mt-0.5"
					style={{ color: "var(--fg-secondary)", fontSize: 11 }}
				>
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
