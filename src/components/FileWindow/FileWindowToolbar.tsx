import { Monitor, Printer, Search, Sun } from "lucide-react";
import type { MarkdownView } from "../../lib/ipc";
import { isMac } from "../../lib/platform";
import type { PreviewColorMode } from "../../lib/previewColorMode";

/** Height of the one bar a File window has. On macOS it is also the title
 *  bar: the native traffic lights float over its left end. */
export const FILE_WINDOW_TOOLBAR_HEIGHT = 34;

// The native traffic lights take roughly the first 70px (see Titlebar).
const MAC_TRAFFIC_LIGHT_INSET = 84;

/** The Rendered / Source switch and the rendered view's tools. Only a
 *  markdown File window has them. */
interface MarkdownControls {
	view: MarkdownView;
	onViewChange: (view: MarkdownView) => void;
	colorMode: PreviewColorMode;
	onToggleColorMode: () => void;
	onFind: () => void;
	onPrint: () => void;
	findLabel: string;
	toggleLabel: string;
}

type Props = {
	fileName: string;
	workspaceName: string;
	dirty?: boolean;
} & (
	| ({ markdown: true } & MarkdownControls)
	| ({ markdown?: false } & Partial<MarkdownControls>)
);

// Colours that change on hover live in classes: an inline colour would beat
// the `hover:` utility (CLAUDE.md, "An inline style silently defeats…").
const iconButtonClass =
	"flex items-center justify-center rounded cursor-pointer border-0 bg-transparent " +
	"text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)] " +
	"focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] transition-colors duration-100";

const segmentClass =
	"flex items-center justify-center rounded-[4px] cursor-pointer border-0 transition-colors duration-100 " +
	"focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]";
const segmentOn = "bg-[var(--bg-primary)] text-[var(--fg-primary)] shadow-sm";
const segmentOff =
	"bg-transparent text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]";

function IconButton({
	icon: Icon,
	label,
	onClick,
}: {
	icon: React.ComponentType<{ size?: number }>;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={onClick}
			className={iconButtonClass}
			style={{ width: 24, height: 24, padding: 0 }}
		>
			<Icon size={14} />
		</button>
	);
}

/**
 * A File window's only chrome: which file, whether it has unsaved edits, and,
 * for markdown, the Rendered / Source switch and the rendered view's tools.
 */
export function FileWindowToolbar(props: Props) {
	const { fileName, workspaceName, dirty = false } = props;
	return (
		<div
			data-tauri-drag-region
			className="flex items-center gap-3 select-none shrink-0"
			style={{
				height: FILE_WINDOW_TOOLBAR_HEIGHT,
				padding: `0 10px 0 ${isMac ? MAC_TRAFFIC_LIGHT_INSET : 12}px`,
				backgroundColor: "var(--bg-secondary)",
				borderBottom: "1px solid var(--border)",
			}}
		>
			<div
				data-tauri-drag-region
				className="flex items-baseline gap-2 min-w-0 flex-1"
				style={{ fontSize: 13 }}
			>
				<span
					data-tauri-drag-region
					className="truncate"
					style={{ color: "var(--fg-primary)", fontWeight: 500 }}
				>
					{fileName}
				</span>
				{dirty && (
					<span
						role="img"
						title="Unsaved changes"
						aria-label="Unsaved changes"
						style={{
							width: 7,
							height: 7,
							borderRadius: "50%",
							background: "var(--accent)",
							flexShrink: 0,
							alignSelf: "center",
						}}
					/>
				)}
				<span
					data-tauri-drag-region
					className="truncate"
					style={{ color: "var(--fg-secondary)", fontSize: 12 }}
				>
					{workspaceName}
				</span>
			</div>

			{props.markdown && <MarkdownTools {...props} />}
		</div>
	);
}

function MarkdownTools({
	view,
	onViewChange,
	colorMode,
	onToggleColorMode,
	onFind,
	onPrint,
	findLabel,
	toggleLabel,
}: MarkdownControls) {
	const views: Array<{ id: MarkdownView; label: string }> = [
		{ id: "rendered", label: "Rendered" },
		{ id: "source", label: "Source" },
	];
	return (
		<>
			<div className="flex items-center gap-1">
				{view === "rendered" && (
					<>
						<IconButton icon={Search} label={findLabel} onClick={onFind} />
						<IconButton
							icon={colorMode === "auto" ? Monitor : Sun}
							label={
								colorMode === "auto"
									? "Following the theme. Switch to printed paper"
									: "Printed paper. Switch to following the theme"
							}
							onClick={onToggleColorMode}
						/>
						<IconButton icon={Printer} label="Print" onClick={onPrint} />
					</>
				)}
			</div>

			<div
				title={toggleLabel}
				className="flex items-center"
				style={{
					padding: 2,
					gap: 2,
					borderRadius: 6,
					background: "var(--bg-tertiary)",
				}}
			>
				{views.map((v) => (
					<button
						key={v.id}
						type="button"
						aria-pressed={view === v.id}
						onClick={() => onViewChange(v.id)}
						className={`${segmentClass} ${view === v.id ? segmentOn : segmentOff}`}
						style={{ height: 22, padding: "0 10px", fontSize: 12 }}
					>
						{v.label}
					</button>
				))}
			</div>
		</>
	);
}
