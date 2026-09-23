import { useCallback, useState } from "react";
import {
	commitsShareFromDrag,
	prRatioFromDrag,
	rightSidebarShares,
} from "../../lib/rightSidebarLayout";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { Explorer } from "../Explorer/Explorer";
import { NotesPanel } from "../Notes/NotesPanel";
import { SearchPanel } from "../Search/SearchPanel";
import { RightSidebarCollapsedStrip } from "./CollapsedStrip";
import { CommitsSection } from "./CommitsSection";
import { GitChangesTab } from "./GitChangesTab";
import { PrSection } from "./PrSection";
import { RightSidebarResizer } from "./Resizer";
import { SectionDivider } from "./SectionDivider";
import { RightSidebarTabStrip } from "./TabStrip";

interface Props {
	titlebarHeight: number;
}

/** Right sidebar: in-workspace toolbox. Tabs (Git changes / Explorer / Search
 *  / Notes) sit above two always-anchored, collapsible **Anchored sections** —
 *  Commits, then Pull Requests — each with its own divider. See
 *  ADR-0010 and `lib/rightSidebarLayout.ts`. */
export function RightSidebar({ titlebarHeight }: Props) {
	const open = useWindowUiStore((s) => s.rightSidebarOpen);
	const activeTab = useWindowUiStore((s) => s.rightSidebarActiveTab);
	const prCollapsed = useWindowUiStore((s) => s.prSectionCollapsed);
	const commitsCollapsed = useWindowUiStore((s) => s.commitsSectionCollapsed);

	const width = useSettingsStore((s) => s.rightSidebarWidth);
	const prRatio = useSettingsStore((s) => s.rightSidebarPrRatio);
	const setPrRatio = useSettingsStore((s) => s.setRightSidebarPrRatio);

	const commitsShare = useSettingsStore((s) => s.rightSidebarCommitsShare);
	const setCommitsShare = useSettingsStore(
		(s) => s.setRightSidebarCommitsShare,
	);

	// Live drag values; persisted only on mouseup, like every other divider.
	const [localRatio, setLocalRatio] = useState<number | null>(null);
	const [localCommits, setLocalCommits] = useState<number | null>(null);
	const ratio = localRatio ?? prRatio;
	const commits = localCommits ?? commitsShare;

	const shares = rightSidebarShares({
		prRatio: ratio,
		commitsShare: commits,
		commitsCollapsed,
		prCollapsed,
	});

	// Bounded by the commits' *drawn* share, not the saved one:
	// `rightSidebarShares` shrinks the commits when the PRs are tall, and a
	// saved share bigger than what is drawn would pin this divider in place.
	const handlePrDividerResize = useCallback(
		(y: number) => {
			setLocalRatio(prRatioFromDrag(y, shares.commits));
		},
		[shares.commits],
	);

	const handlePrDividerResizeEnd = useCallback(() => {
		if (localRatio !== null) {
			setPrRatio(localRatio);
			setLocalRatio(null);
		}
	}, [localRatio, setPrRatio]);

	const handleCommitsDividerResize = useCallback(
		(y: number) => {
			setLocalCommits(commitsShareFromDrag(y, shares.pr));
		},
		[shares.pr],
	);

	const handleCommitsDividerResizeEnd = useCallback(() => {
		if (localCommits !== null) {
			setCommitsShare(localCommits);
			setLocalCommits(null);
		}
	}, [localCommits, setCommitsShare]);

	if (!open) {
		return <RightSidebarCollapsedStrip titlebarHeight={titlebarHeight} />;
	}

	return (
		<div
			className="flex flex-col flex-shrink-0 h-full relative"
			style={{
				width,
				// Linear ambient glow rising from the bottom, mirroring the left
				// sidebar (--ambient-glow over bg-secondary). The panels inside
				// (tab strip, tab content, PR section) are transparent so the glow
				// shows through.
				background: "var(--ambient-glow), var(--bg-secondary)",
				borderLeft: "1px solid var(--border)",
				paddingTop: titlebarHeight,
			}}
		>
			{/* Resize handle pinned to the sidebar's left edge (absolute), so it
			    lives inside the sidebar rather than the content row. */}
			<RightSidebarResizer titlebarHeight={titlebarHeight} />
			<RightSidebarTabStrip />

			{/* Active tab content. Takes whatever the expanded Anchored sections
			 *  leave, including the share of any collapsed one. */}
			<div
				className="flex flex-col min-h-0"
				style={{ flex: `${shares.tab} 1 0%` }}
			>
				{activeTab === "git" && <GitChangesTab />}
				{activeTab === "explorer" && <Explorer />}
				{activeTab === "search" && <SearchPanel />}
				{activeTab === "notes" && <NotesPanel />}
			</div>

			{!commitsCollapsed && (
				<SectionDivider
					onResize={handleCommitsDividerResize}
					onResizeEnd={handleCommitsDividerResizeEnd}
				/>
			)}

			{/* Commits. Collapsed: only its header pins. */}
			<div
				className="flex flex-col flex-shrink-0 min-h-0"
				style={{
					flex: commitsCollapsed ? "0 0 auto" : `${shares.commits} 1 0%`,
				}}
			>
				<CommitsSection />
			</div>

			{!prCollapsed && (
				<SectionDivider
					onResize={handlePrDividerResize}
					onResizeEnd={handlePrDividerResizeEnd}
				/>
			)}

			{/* PR section. When collapsed, only its 30px header pins at the
			 *  bottom (flex: 0 0 auto). When expanded, it takes the remaining
			 *  ratio share of the panel height. */}
			<div
				className="flex flex-col flex-shrink-0 min-h-0"
				style={{
					flex: prCollapsed ? "0 0 auto" : `${shares.pr} 1 0%`,
				}}
			>
				<PrSection />
			</div>
		</div>
	);
}
