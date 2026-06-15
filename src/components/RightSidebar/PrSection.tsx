import { useWindowUiStore } from "../../stores/windowUiStore";
import { PullRequestsSection } from "../GitChanges/PullRequestsSection";
import { ChevronDown, ChevronRight, GitPullRequest } from "../Icons";

const PR_HEADER_HEIGHT = 30;

/** The Pull Requests section anchored at the bottom of the right sidebar.
 *  Always renders its header (collapse target); body is hidden when
 *  collapsed. Height is controlled by the parent — `flex` set to a ratio
 *  share when expanded, or `0 0 auto` so only the header pins when
 *  collapsed. */
export function PrSection() {
	const collapsed = useWindowUiStore((s) => s.prSectionCollapsed);
	const toggle = useWindowUiStore((s) => s.togglePrSectionCollapsed);

	return (
		<div
			className="flex flex-col min-h-0"
			style={{
				borderTop: collapsed ? "1px solid var(--border)" : "none",
				// Transparent so the sidebar's ambient glow shows through.
				backgroundColor: "transparent",
				flex: "1 1 0%",
			}}
		>
			<button
				type="button"
				onClick={toggle}
				className="flex items-center gap-1.5 flex-shrink-0 transition-colors"
				style={{
					height: PR_HEADER_HEIGHT,
					paddingLeft: 10,
					paddingRight: 10,
					borderBottom: collapsed ? "none" : "1px solid var(--border)",
					color: "var(--fg-secondary)",
					transitionDuration: "var(--transition-fast)",
					cursor: "pointer",
					textAlign: "left",
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.backgroundColor = "transparent";
				}}
				title={collapsed ? "Expand Pull Requests" : "Collapse Pull Requests"}
			>
				<span
					style={{
						display: "inline-flex",
						transition: "transform var(--transition-fast)",
						transform: collapsed ? "rotate(0deg)" : "rotate(0deg)",
					}}
				>
					{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
				</span>
				<GitPullRequest size={12} style={{ color: "var(--accent)" }} />
				<span
					className="font-semibold"
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						letterSpacing: "0.05em",
						textTransform: "uppercase",
					}}
				>
					Pull Requests
				</span>
			</button>

			{!collapsed && (
				<div className="flex-1 min-h-0">
					<PullRequestsSection />
				</div>
			)}
		</div>
	);
}
