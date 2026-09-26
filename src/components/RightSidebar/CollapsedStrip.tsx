import {
	shortcutLabelFor,
	useKeybindingOverrides,
	withShortcut,
} from "../../hooks/useShortcutLabel";
import type { KeyAction } from "../../lib/keybindings";
import {
	type RightSidebarTab,
	useWindowUiStore,
} from "../../stores/windowUiStore";
import { Folder, GitCompare, Search, StickyNote } from "../Icons";

interface IconButtonProps {
	tab: RightSidebarTab;
	label: string;
	shortcut: KeyAction;
	icon: React.ComponentType<{ size?: number }>;
}

const ICONS: IconButtonProps[] = [
	{
		tab: "git",
		label: "Git changes",
		shortcut: "toggle-right-sidebar-git",
		icon: GitCompare,
	},
	{
		tab: "explorer",
		label: "Explorer",
		shortcut: "toggle-right-sidebar-explorer",
		icon: Folder,
	},
	{
		tab: "search",
		label: "Search",
		shortcut: "search-in-workspace",
		icon: Search,
	},
	{
		tab: "notes",
		label: "Notes",
		shortcut: "toggle-right-sidebar-notes",
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
	const overrides = useKeybindingOverrides();

	return (
		<div
			className="flex flex-col items-center flex-shrink-0"
			style={{
				width: 44,
				paddingTop: titlebarHeight + 8,
				gap: 4,
				// Linear ambient glow rising from the bottom, matching the expanded
				// right sidebar and the left sidebar (--ambient-glow over bg-secondary).
				background: "var(--ambient-glow), var(--bg-secondary)",
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
						title={withShortcut(label, shortcutLabelFor(shortcut, overrides))}
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
