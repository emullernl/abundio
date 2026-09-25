import { LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { MAX_COLUMNS, MAX_VISIBLE_ROWS } from "../../lib/fleetConsole";
import type { FleetGrid } from "../../stores/windowUiStore";

interface Props {
	preset: FleetGrid["preset"];
	/** What Auto currently resolves to, shown beside the word. */
	autoShape: { columns: number; rows: number };
	onChange: (preset: FleetGrid["preset"]) => void;
}

const CELL = 16;
const CELL_GAP = 3;

/**
 * The grid-size control: a small matrix you sweep across to pick
 * columns × visible rows, like a table-size picker, plus Auto. The rows are
 * how many fit on screen, not how many exist — more agents add rows and the
 * console scrolls.
 */
export function GridPicker({ preset, autoShape, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const [hover, setHover] = useState<{ columns: number; rows: number } | null>(
		null,
	);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown, true);
		return () => document.removeEventListener("mousedown", onDown, true);
	}, [open]);

	const current =
		preset === "auto"
			? autoShape
			: { columns: preset.columns, rows: preset.rows };
	const shown = hover ?? current;
	const label =
		preset === "auto"
			? `Auto · ${autoShape.columns}×${autoShape.rows}`
			: `${preset.columns}×${preset.rows}`;

	const pick = (next: FleetGrid["preset"]) => {
		onChange(next);
		setOpen(false);
		setHover(null);
	};

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="Grid size — columns × rows on screen"
				className="flex items-center text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-tertiary)]"
				style={{
					height: 24,
					padding: "0 8px",
					gap: 6,
					borderRadius: 5,
					border: "1px solid var(--border)",
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					cursor: "pointer",
					transition: "background 120ms ease, color 120ms ease",
				}}
			>
				<LayoutGrid size={12} />
				{label}
			</button>
			{open && (
				<GridPickerPopover
					preset={preset}
					shown={shown}
					current={current}
					hover={hover}
					setHover={setHover}
					onPick={pick}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

function GridPickerPopover({
	preset,
	shown,
	current,
	hover,
	setHover,
	onPick,
	onClose,
}: {
	preset: FleetGrid["preset"];
	shown: { columns: number; rows: number };
	current: { columns: number; rows: number };
	hover: { columns: number; rows: number } | null;
	setHover: (h: { columns: number; rows: number } | null) => void;
	onPick: (p: FleetGrid["preset"]) => void;
	onClose: () => void;
}) {
	useEscapeKey(onClose);
	const cells: { c: number; r: number }[] = [];
	for (let r = 1; r <= MAX_VISIBLE_ROWS; r++) {
		for (let c = 1; c <= MAX_COLUMNS; c++) cells.push({ c, r });
	}
	return (
		<div
			className="absolute right-0 z-50 select-none"
			style={{
				top: "calc(100% + 6px)",
				padding: 10,
				borderRadius: 8,
				border: "1px solid var(--border)",
				background: "var(--bg-secondary)",
				boxShadow: "0 12px 32px rgb(0 0 0 / 0.35)",
			}}
		>
			<button
				type="button"
				onClick={() => onPick("auto")}
				className="w-full flex items-center justify-between hover:bg-[var(--bg-tertiary)]"
				style={{
					padding: "4px 6px",
					marginBottom: 8,
					borderRadius: 4,
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					color: preset === "auto" ? "var(--accent)" : "var(--fg-primary)",
					cursor: "pointer",
				}}
			>
				<span>Auto</span>
				<span style={{ color: "var(--fg-secondary)", fontSize: 10 }}>
					fits the agents
				</span>
			</button>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: hover preview only; every cell is a button */}
			<div
				onMouseLeave={() => setHover(null)}
				style={{
					display: "grid",
					gridTemplateColumns: `repeat(${MAX_COLUMNS}, ${CELL}px)`,
					gap: CELL_GAP,
				}}
			>
				{cells.map(({ c, r }) => {
					const lit = c <= shown.columns && r <= shown.rows;
					const isCurrent =
						!hover &&
						preset !== "auto" &&
						c <= current.columns &&
						r <= current.rows;
					return (
						<button
							key={`${c}x${r}`}
							type="button"
							aria-label={`${c} columns by ${r} rows`}
							onMouseEnter={() => setHover({ columns: c, rows: r })}
							onFocus={() => setHover({ columns: c, rows: r })}
							onClick={() => onPick({ columns: c, rows: r })}
							style={{
								width: CELL,
								height: CELL * 0.72,
								borderRadius: 2,
								cursor: "pointer",
								border: `1px solid ${lit ? "var(--accent)" : "var(--border)"}`,
								background: lit
									? `color-mix(in srgb, var(--accent) ${isCurrent ? 35 : 22}%, transparent)`
									: "transparent",
								transition: "background 80ms ease, border-color 80ms ease",
							}}
						/>
					);
				})}
			</div>
			<div
				style={{
					marginTop: 8,
					textAlign: "center",
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					color: "var(--fg-secondary)",
				}}
			>
				{shown.columns} × {shown.rows}
				<span style={{ opacity: 0.6 }}> on screen</span>
			</div>
		</div>
	);
}
