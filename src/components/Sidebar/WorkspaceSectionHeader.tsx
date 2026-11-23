import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { useHiddenRollup } from "../../hooks/useWorkspaceRollups";
import { sectionSummary } from "../../lib/sectionSummary";
import type { WorkspaceWithTabs } from "../../lib/types";
import { useWindowUiStore } from "../../stores/windowUiStore";

/**
 * A Workspace list section's header (docs/plans/remote-hosts.md phase 10):
 * this Window's own Profile, or a Joined profile. Click it to fold the
 * section to this line; it always sums up what is in it ("3 workspaces ·
 * 1 waiting · 2 working"), so folding hides no news.
 */
export function WorkspaceSectionHeader({
	sectionKey,
	icon,
	label,
	workspaces,
	title,
	trailing,
	status,
}: {
	sectionKey: string;
	icon: ReactNode;
	label: string;
	workspaces: WorkspaceWithTabs[];
	title?: string;
	/** Beside the label: a connection dot, a menu. */
	trailing?: ReactNode;
	/** In place of the summary (a Host that is away: "last seen …"). */
	status?: ReactNode;
}) {
	const folded = useWindowUiStore((s) =>
		s.foldedSectionKeys.includes(sectionKey),
	);
	const toggle = useWindowUiStore((s) => s.toggleSectionFolded);
	const rollup = useHiddenRollup(workspaces);
	return (
		<div className="group flex flex-col" style={{ padding: "4px 8px 2px 6px" }}>
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					className="flex items-center gap-1.5 flex-1 min-w-0 text-left rounded hover:bg-[var(--bg-tertiary)] transition-colors"
					style={{ padding: "2px 4px" }}
					aria-expanded={!folded}
					title={title}
					onClick={() => toggle(sectionKey)}
				>
					<ChevronRight
						size={12}
						style={{
							flexShrink: 0,
							color: "var(--fg-secondary)",
							transform: folded ? undefined : "rotate(90deg)",
							transition: "transform 120ms",
						}}
					/>
					<span
						style={{
							flexShrink: 0,
							color: "var(--fg-secondary)",
							display: "flex",
						}}
					>
						{icon}
					</span>
					<span
						className="truncate uppercase"
						style={{
							fontSize: 10,
							letterSpacing: "0.06em",
							fontWeight: 600,
							color: "var(--fg-secondary)",
						}}
					>
						{label}
					</span>
				</button>
				{trailing}
			</div>
			<div
				className="truncate"
				style={{
					padding: "0 4px 0 36px",
					fontSize: 11,
					color: "var(--fg-secondary)",
				}}
			>
				{status ?? sectionSummary(workspaces.length, rollup)}
			</div>
		</div>
	);
}

/** Whether a section is folded, for the list that draws its rows. */
export function useSectionFolded(sectionKey: string): boolean {
	return useWindowUiStore((s) => s.foldedSectionKeys.includes(sectionKey));
}
