import { useCallback, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { Explorer } from "../Explorer/Explorer";
import { SearchPanel } from "../Search/SearchPanel";
import { RightSidebarCollapsedStrip } from "./CollapsedStrip";
import { GitChangesTab } from "./GitChangesTab";
import { PrSection } from "./PrSection";
import { RightSidebarResizer } from "./Resizer";
import { SectionDivider } from "./SectionDivider";
import { RightSidebarTabStrip } from "./TabStrip";

interface Props {
	titlebarHeight: number;
}

/** Right sidebar: in-workspace toolbox. Tabs (Git changes / Explorer / Search)
 *  sit above an always-anchored, collapsible Pull Requests section. See
 *  ADR-0010. */
export function RightSidebar({ titlebarHeight }: Props) {
	const open = useWindowUiStore((s) => s.rightSidebarOpen);
	const activeTab = useWindowUiStore((s) => s.rightSidebarActiveTab);
	const prCollapsed = useWindowUiStore((s) => s.prSectionCollapsed);

	const width = useSettingsStore((s) => s.rightSidebarWidth);
	const prRatio = useSettingsStore((s) => s.rightSidebarPrRatio);
	const setPrRatio = useSettingsStore((s) => s.setRightSidebarPrRatio);

	const [localRatio, setLocalRatio] = useState<number | null>(null);
	const ratio = localRatio ?? prRatio;

	const handleDividerResize = useCallback((r: number) => {
		setLocalRatio(r);
	}, []);

	const handleDividerResizeEnd = useCallback(() => {
		if (localRatio !== null) {
			setPrRatio(localRatio);
			setLocalRatio(null);
		}
	}, [localRatio, setPrRatio]);

	if (!open) {
		return <RightSidebarCollapsedStrip titlebarHeight={titlebarHeight} />;
	}

	return (
		<>
			<RightSidebarResizer />
			<div
				className="flex flex-col flex-shrink-0 h-full"
				style={{
					width,
					backgroundColor: "var(--bg-secondary)",
					borderLeft: "1px solid var(--border)",
					paddingTop: titlebarHeight,
				}}
			>
				<RightSidebarTabStrip />

				{/* Top half: active tab content. When the PR section is collapsed,
				 *  the tab content stretches to fill all available height; when the
				 *  PR section is expanded, the two share the height via prRatio. */}
				<div
					className="flex flex-col min-h-0"
					style={{ flex: prCollapsed ? "1 1 0%" : `${ratio} 1 0%` }}
				>
					{activeTab === "git" && <GitChangesTab />}
					{activeTab === "explorer" && <Explorer />}
					{activeTab === "search" && <SearchPanel />}
				</div>

				{!prCollapsed && (
					<SectionDivider
						onResize={handleDividerResize}
						onResizeEnd={handleDividerResizeEnd}
					/>
				)}

				{/* PR section. When collapsed, only its 30px header pins at the
				 *  bottom (flex: 0 0 auto). When expanded, it takes the remaining
				 *  ratio share of the panel height. */}
				<div
					className="flex flex-col flex-shrink-0 min-h-0"
					style={{
						flex: prCollapsed ? "0 0 auto" : `${1 - ratio} 1 0%`,
					}}
				>
					<PrSection />
				</div>
			</div>
		</>
	);
}
