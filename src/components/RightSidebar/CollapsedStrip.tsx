import {
	type RightSidebarTab,
	useWindowUiStore,
} from "../../stores/windowUiStore";
import { isMac } from "../../lib/platform";
import { Folder, GitCompare, Search, StickyNote } from "../Icons";

interface IconButtonProps {
	tab: RightSidebarTab;
	label: string;
	shortcut: string;
	icon: React.ComponentType<{ size?: number }>;
}

const ICONS: IconButtonProps[] = [
	{
		tab: "git",
		label: "Git changes",
		shortcut: isMac ? "⇧⌘G" : "Ctrl+Shift+G",
		icon: GitCompare,
	},
	{
		tab: "explorer",
		label: "Explorer",
		shortcut: isMac ? "⇧⌘E" : "Ctrl+Shift+E",
		icon: Folder,
	},
	{
		tab: "search",
		label: "Search",
		shortcut: isMac ? "⇧⌘F" : "Ctrl+Shift+F",
		icon: Search,
	},
	{
		tab: "notes",
		label: "Notes",
		shortcut: isMac ? "⇧⌘K" : "Ctrl+Shift+K",
		icon: StickyNote,
	},
];

interface Props {
	titlebarHeight: number;
}

/** 44px-wide vertical strip shown when the right sidebar is closed.
 *  Stacks the three tab icons; the active-tab icon is accent-coloured so the
 *  user can see which tab will restore on next open without clicking. */
export function RightSidebarCollapsedStrip({ titlebarHeight }: Props) {
	const activeTab = useWindowUiStore((s) => s.rightSidebarActiveTab);
	const setActiveTab = useWindowUiStore((s) => s.setRightSidebarActiveTab);
	const setOpen = useWindowUiStore((s) => s.setRightSidebarOpen);

	return (
		<div
			className="flex flex-col items-center flex-shrink-0"
			style={{
				width: 44,
				paddingTop: titlebarHeight + 8,
				gap: 4,
				backgroundColor: "var(--bg-secondary)",
				borderLeft: "1px solid var(--border)",
			}}
		>
			{ICONS.map(({ tab, label, shortcut, icon: Icon }) => {
				const isActive = activeTab === tab;
				return (
					<button
						key={tab}
						type="button"
						onClick={() => {
							setActiveTab(tab);
							setOpen(true);
						}}
						title={`${label} (${shortcut})`}
						className="flex items-center justify-center rounded-md transition-colors"
						style={{
							width: 32,
							height: 32,
							color: isActive ? "var(--accent)" : "var(--fg-secondary)",
							backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
							transitionDuration: "var(--transition-fast)",
						}}
						onMouseEnter={(e) => {
							if (!isActive) {
								e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
								e.currentTarget.style.color = "var(--fg-primary)";
							}
						}}
						onMouseLeave={(e) => {
							if (!isActive) {
								e.currentTarget.style.backgroundColor = "transparent";
								e.currentTarget.style.color = "var(--fg-secondary)";
							}
						}}
					>
						<Icon size={16} />
					</button>
				);
			})}
		</div>
	);
}
