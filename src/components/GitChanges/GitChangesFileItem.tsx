import type { GitChangedFile } from "../../lib/types";
import { File } from "../Icons";

interface Props {
	file: GitChangedFile;
	isSelected: boolean;
	/** The row the **Row menu** is currently open on. Deliberately separate from
	 *  `isSelected`: selecting a row opens a file pane, and asking what a menu
	 *  holds must not open one. */
	isMenuTarget: boolean;
	onClick: () => void;
	onOpenFile: () => void;
	onContextMenu: (x: number, y: number, fromKeyboard: boolean) => void;
}

const STATUS_COLORS: Record<string, string> = {
	A: "var(--success)",
	M: "var(--warning)",
	D: "var(--error)",
	R: "var(--accent)",
	"?": "var(--fg-secondary)",
	U: "var(--error)",
};

const STATUS_LABELS: Record<string, string> = {
	A: "A",
	M: "M",
	D: "D",
	R: "R",
	"?": "U",
	U: "U",
};

function fileName(path: string): string {
	return path.split("/").pop() ?? path;
}

function dirPath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 1) return "";
	return parts.slice(0, -1).join("/");
}

export function GitChangesFileItem({
	file,
	isSelected,
	isMenuTarget,
	onClick,
	onOpenFile,
	onContextMenu,
}: Props) {
	const color = STATUS_COLORS[file.status] ?? "var(--fg-secondary)";
	const label = STATUS_LABELS[file.status] ?? file.status;
	const dir = dirPath(file.path);
	const isDeleted = file.status === "D";
	// A conflicted row's own click already opens the text pane, so the nested
	// "Open File" button would be a duplicate of it.
	const isConflicted = file.section === "conflicted";
	const hideOpenFile = isDeleted || isConflicted;

	return (
		// biome-ignore lint/a11y/useSemanticElements: div used intentionally for styling — hosts a nested "Open File" button
		<div
			role="button"
			tabIndex={0}
			// Without these the Row menu is conveyed only by the accent ring, so a
			// screen-reader user gets no signal that the row has a menu at all.
			aria-haspopup="menu"
			aria-expanded={isMenuTarget}
			onClick={onClick}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onContextMenu(e.clientX, e.clientY, false);
			}}
			onKeyDown={(e) => {
				// The row advertises itself as a button, so the menu it carries has
				// to be reachable without a pointer. Anchored to the row's own box
				// rather than a cursor that is somewhere else entirely.
				//
				// Deliberately handled before the self-target guard below: a
				// right-click on the nested "Open File" button opens the row's menu
				// (the contextmenu event bubbles), so the key must do the same from
				// there rather than going dead while that button holds focus.
				if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
					e.preventDefault();
					const rect = e.currentTarget.getBoundingClientRect();
					onContextMenu(rect.left + 12, rect.bottom, true);
					return;
				}
				// Only respond to the remaining keys when targeted at the row itself
				// — otherwise a keypress on the nested "Open File" button bubbles up
				// here and opens the diff too (its keydown isn't stopped by the
				// click-time stopPropagation). Space is handled to match native
				// button behavior.
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter") {
					onClick();
				} else if (e.key === " ") {
					e.preventDefault();
					onClick();
				}
			}}
			// select-none: a right-click on selectable text makes the browser select
			// the word under the cursor as it opens the menu, so the row would flash a
			// text selection behind its own menu. The row acts as a button, not prose.
			className="w-full flex items-center gap-2 py-1 text-left transition-colors group cursor-pointer select-none"
			style={{
				height: 28,
				// Inline padding instead of Tailwind px-3 to avoid specificity issues with the borderLeft style
				paddingLeft: 12,
				paddingRight: 12,
				backgroundColor: isSelected ? "var(--bg-tertiary)" : "transparent",
				borderLeft: isSelected
					? "2px solid var(--accent)"
					: "2px solid transparent",
				// A ring, not a background: the hover handlers below write
				// backgroundColor directly, so a background highlight would be wiped
				// the moment the pointer left the row on its way to the menu. The
				// ring also reads clearly as "this is what the menu is about" rather
				// than as a second selected row.
				boxShadow: isMenuTarget ? "inset 0 0 0 1px var(--accent)" : undefined,
			}}
			onMouseEnter={(e) => {
				if (!isSelected)
					e.currentTarget.style.backgroundColor =
						"color-mix(in srgb, var(--bg-tertiary) 60%, transparent)";
			}}
			onMouseLeave={(e) => {
				if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<span
				className="flex-shrink-0 inline-flex items-center justify-center rounded font-bold"
				style={{
					width: 18,
					height: 18,
					fontSize: 10,
					color,
					backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
					fontFamily: "var(--font-ui)",
				}}
			>
				{label}
			</span>
			<span
				className="truncate flex-1 min-w-0"
				style={{
					fontSize: 12,
					color: "var(--fg-primary)",
					fontFamily: "var(--font-ui)",
				}}
			>
				{fileName(file.path)}
				{dir && (
					<span style={{ color: "var(--fg-secondary)", marginLeft: 4 }}>
						{dir}
					</span>
				)}
			</span>
			{hideOpenFile ? (
				<span className="flex-shrink-0" style={{ width: 18, height: 18 }} />
			) : (
				<button
					type="button"
					title="Open File"
					onClick={(e) => {
						e.stopPropagation();
						onOpenFile();
					}}
					className="flex items-center justify-center rounded transition-opacity opacity-0 group-hover:opacity-70 hover:!opacity-100 flex-shrink-0"
					style={{
						width: 18,
						height: 18,
						color: "var(--fg-secondary)",
						background: "none",
						border: "none",
						cursor: "pointer",
						padding: 0,
					}}
				>
					<File size={12} />
				</button>
			)}
			<span
				className="flex-shrink-0 flex items-center gap-1"
				style={{ fontSize: 11, fontFamily: "var(--font-ui)" }}
			>
				{file.additions > 0 && (
					<span style={{ color: "var(--success)" }}>+{file.additions}</span>
				)}
				{file.deletions > 0 && (
					<span style={{ color: "var(--error)" }}>-{file.deletions}</span>
				)}
			</span>
		</div>
	);
}
