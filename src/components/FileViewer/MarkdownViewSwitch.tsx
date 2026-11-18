import type { MarkdownView } from "../../lib/types";

const segmentClass =
	"flex items-center justify-center rounded-[4px] cursor-pointer border-0 transition-colors duration-100 " +
	"focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] " +
	"disabled:cursor-default disabled:opacity-50";
const segmentOn = "bg-[var(--bg-primary)] text-[var(--fg-primary)] shadow-sm";
const segmentOff =
	"bg-transparent text-[var(--fg-secondary)] enabled:hover:text-[var(--fg-primary)]";

const VIEWS: Array<{ id: MarkdownView; label: string }> = [
	{ id: "rendered", label: "Rendered" },
	{ id: "source", label: "Source" },
];

// The File window's bar is 34px; a pane's title bar is 22px.
const SIZES = {
	window: { height: 22, padding: "0 10px", fontSize: 12, inset: 2 },
	pane: { height: 16, padding: "0 7px", fontSize: 10.5, inset: 1 },
} as const;

/**
 * The Rendered / Source switch of a markdown file (ADR-0061): the same
 * control in a File window's toolbar and a File pane's title bar.
 */
export function MarkdownViewSwitch({
	view,
	onChange,
	title,
	size,
	disabled = false,
}: {
	view: MarkdownView;
	onChange: (view: MarkdownView) => void;
	/** Tooltip: what the switch does and its shortcut, or why it is off. */
	title: string;
	size: keyof typeof SIZES;
	disabled?: boolean;
}) {
	const s = SIZES[size];
	return (
		<div
			title={title}
			className="flex items-center shrink-0"
			style={{
				padding: s.inset,
				gap: s.inset,
				borderRadius: size === "window" ? 6 : 5,
				background: "var(--bg-tertiary)",
			}}
		>
			{VIEWS.map((v) => (
				<button
					key={v.id}
					type="button"
					aria-pressed={view === v.id}
					disabled={disabled}
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						if (view !== v.id) onChange(v.id);
					}}
					className={`${segmentClass} ${view === v.id ? segmentOn : segmentOff}`}
					style={{ height: s.height, padding: s.padding, fontSize: s.fontSize }}
				>
					{v.label}
				</button>
			))}
		</div>
	);
}
