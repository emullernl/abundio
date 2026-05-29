import {
	type RightSidebarTab,
	useWindowUiStore,
} from "../../stores/windowUiStore";
import { Folder, GitCompare, PanelRight, Search, StickyNote } from "../Icons";

interface TabDef {
	id: RightSidebarTab;
	label: string;
	icon: React.ComponentType<{ size?: number }>;
	shortcut: string;
}

const TABS: TabDef[] = [
	{ id: "git", label: "Git changes", icon: GitCompare, shortcut: "⇧⌘G" },
	{ id: "explorer", label: "Explorer", icon: Folder, shortcut: "⇧⌘E" },
	{ id: "search", label: "Search", icon: Search, shortcut: "⇧⌘F" },
	{ id: "notes", label: "Notes", icon: StickyNote, shortcut: "⇧⌘K" },
];

/** Horizontal tab strip at the top of the expanded right sidebar.
 *  Active tab is marked by an accent text color, a bg-tertiary fill, and a
 *  2px inset bottom border in the accent colour — the bottom bar visually
 *  bonds the active tab to its content area underneath. */
export function RightSidebarTabStrip() {
	const activeTab = useWindowUiStore((s) => s.rightSidebarActiveTab);
	const setActiveTab = useWindowUiStore((s) => s.setRightSidebarActiveTab);
	const toggle = useWindowUiStore((s) => s.toggleRightSidebar);

	return (
		<div
			className="flex items-center flex-shrink-0"
			style={{
				height: 36,
				paddingLeft: 6,
				paddingRight: 6,
				borderBottom: "1px solid var(--border)",
				backgroundColor: "var(--bg-secondary)",
			}}
		>
			<div className="flex items-center gap-0.5">
				{TABS.map((tab) => {
					const Icon = tab.icon;
					const isActive = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => setActiveTab(tab.id)}
							title={`${tab.label} (${tab.shortcut})`}
							className="flex items-center justify-center rounded-md transition-colors"
							style={{
								width: 30,
								height: 28,
								color: isActive ? "var(--accent)" : "var(--fg-secondary)",
								backgroundColor: isActive
									? "var(--bg-tertiary)"
									: "transparent",
								boxShadow: isActive ? "inset 0 -2px 0 0 var(--accent)" : "none",
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
							<Icon size={14} />
						</button>
					);
				})}
			</div>

			<div className="flex-1" />

			<button
				type="button"
				onClick={toggle}
				title="Close sidebar"
				className="flex items-center justify-center rounded transition-colors"
				style={{
					width: 24,
					height: 24,
					color: "var(--fg-secondary)",
					transitionDuration: "var(--transition-fast)",
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
					e.currentTarget.style.color = "var(--fg-primary)";
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.backgroundColor = "transparent";
					e.currentTarget.style.color = "var(--fg-secondary)";
				}}
			>
				<PanelRight size={12} />
			</button>
		</div>
	);
}
