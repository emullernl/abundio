import type { FolderNode } from "../../lib/changesTree";
import { ChevronDown, ChevronRight, Folder } from "../Icons";
import { TREE_INDENT } from "./GitChangesFileItem";

interface Props {
	node: FolderNode;
	depth: number;
	collapsed: boolean;
	/** The row the **Folder menu** is currently open on. */
	isMenuTarget: boolean;
	onToggle: () => void;
	onContextMenu: (x: number, y: number, fromKeyboard: boolean) => void;
}

/**
 * A **Folder row** in the Git changes tab's Tree view. Name only, no counts:
 * the Section header already carries them. See GLOSSARY.md.
 */
export function GitChangesFolderRow({
	node,
	depth,
	collapsed,
	isMenuTarget,
	onToggle,
	onContextMenu,
}: Props) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: matches the file rows, which are divs acting as buttons
		<div
			role="button"
			tabIndex={0}
			aria-expanded={!collapsed}
			aria-haspopup="menu"
			title={node.path}
			onClick={onToggle}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onContextMenu(e.clientX, e.clientY, false);
			}}
			onKeyDown={(e) => {
				if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
					e.preventDefault();
					const rect = e.currentTarget.getBoundingClientRect();
					onContextMenu(rect.left + 12, rect.bottom, true);
					return;
				}
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onToggle();
				}
			}}
			className="w-full flex items-center gap-1 text-left cursor-pointer select-none hover:bg-[color-mix(in_srgb,var(--bg-tertiary)_60%,transparent)]"
			style={{
				height: 28,
				paddingLeft: 12 + depth * TREE_INDENT,
				paddingRight: 12,
				borderLeft: "2px solid transparent",
				boxShadow: isMenuTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
			}}
		>
			{collapsed ? (
				<ChevronRight
					size={12}
					className="flex-shrink-0"
					style={{ color: "var(--fg-secondary)" }}
				/>
			) : (
				<ChevronDown
					size={12}
					className="flex-shrink-0"
					style={{ color: "var(--fg-secondary)" }}
				/>
			)}
			<Folder
				size={13}
				className="flex-shrink-0"
				style={{ color: "var(--fg-secondary)" }}
			/>
			<span
				className="truncate flex-1 min-w-0"
				style={{
					fontSize: 12,
					color: "var(--fg-primary)",
					fontFamily: "var(--font-ui)",
				}}
			>
				{node.name}
			</span>
		</div>
	);
}
