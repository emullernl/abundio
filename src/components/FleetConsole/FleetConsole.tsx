import { Plus, ZoomIn } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	autoColumns,
	autoVisibleRows,
	dragDivider,
	type FleetTile as FleetTileData,
	fleetTiles,
	gridShape,
	normalizeRatios,
} from "../../lib/fleetConsole";
import { publishFleetGrid } from "../../lib/fleetFocus";
import { getTerminal } from "../../lib/terminalManager";
import {
	buildWorkspaceRows,
	flattenRowsToIds,
} from "../../lib/worktreeGrouping";
import { usePtyActivityStore } from "../../stores/ptyActivityStore";
import {
	TILE_ZOOM_DEFAULT,
	TILE_ZOOM_MAX,
	TILE_ZOOM_MIN,
	TILE_ZOOM_STEP,
	useWindowUiStore,
} from "../../stores/windowUiStore";
import { useWorkspaceGitStore } from "../../stores/workspaceGitStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FleetTile } from "./FleetTile";
import { GridPicker } from "./GridPicker";
import { NewAgentDialog } from "./NewAgentDialog";

const TOOLBAR_HEIGHT = 36;
/** How long a just-started Agent may take to reach agent mode before the
 *  console stops holding focus for its tile. */
const PENDING_TILE_MS = 20_000;
const DIVIDER_HIT = 8;

/** The live tile list, in derived order. Shared by the console and by the
 *  keyboard routing, which must walk the same order the grid shows. */
export function useFleetTiles(): FleetTileData[] {
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const worktreeFacts = useWorkspaceGitStore((s) => s.worktreeFacts);
	const openedWorkspaceIds = usePtyActivityStore((s) => s.openedWorkspaceIds);
	const panePtyMap = usePtyActivityStore((s) => s.panePtyMap);
	// Membership only changes with detection mode, so select a stable key of
	// the agent-mode ptyIds rather than the whole (hot) activities map.
	const agentKey = usePtyActivityStore((s) =>
		Object.keys(s.activities)
			.filter((id) => s.activities[id]?.detectionMode === "agent")
			.sort()
			.join("|"),
	);
	const pendingPaneId = useWindowUiStore((s) => s.pendingTile?.paneId ?? null);
	return useMemo(() => {
		void agentKey;
		return fleetTiles({
			alsoShow: pendingPaneId ? new Set([pendingPaneId]) : undefined,
			workspaces,
			sidebarOrder: flattenRowsToIds(
				buildWorkspaceRows(workspaces, worktreeFacts),
			),
			openedWorkspaceIds,
			activities: usePtyActivityStore.getState().activities,
			panePtyMap,
		});
	}, [
		workspaces,
		worktreeFacts,
		openedWorkspaceIds,
		panePtyMap,
		agentKey,
		pendingPaneId,
	]);
}

/**
 * The **Fleet Console**: every agent-mode pane of this Window's Opened
 * workspaces as a grid of live **Fleet tiles**. Replaces everything between
 * the Overview bar and the Status bar while open. See ADR-0040.
 */
export function FleetConsole({ topOffset }: { topOffset: number }) {
	const open = useWindowUiStore((s) => s.fleetConsoleOpen);
	if (!open) return null;
	return <FleetConsoleBody topOffset={topOffset} />;
}

function FleetConsoleBody({ topOffset }: { topOffset: number }) {
	const tiles = useFleetTiles();
	const workspaces = useWorkspaceStore((s) => s.workspaces);
	const gitById = useWorkspaceGitStore((s) => s.byWorkspaceId);
	const focusedTileId = useWindowUiStore((s) => s.focusedTileId);
	const grid = useWindowUiStore((s) => s.fleetGrid);
	const setFleetPreset = useWindowUiStore((s) => s.setFleetPreset);
	const setFleetRatios = useWindowUiStore((s) => s.setFleetRatios);
	const setTileZoom = useWindowUiStore((s) => s.setTileZoom);
	const setFilmstripRatio = useWindowUiStore((s) => s.setFilmstripRatio);
	const spotlightTileId = useWindowUiStore((s) => s.spotlightTileId);
	const [newAgentOpen, setNewAgentOpen] = useState(false);
	// **Spotlight** is on only while its agent is still a tile.
	const spotlight = tiles.some((t) => t.paneId === spotlightTileId)
		? spotlightTileId
		: null;

	// ── Measure the scroll area: Auto and the row heights depend on it. ──
	const scrollRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () =>
			setSize({ width: el.clientWidth, height: el.clientHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const autoShape = useMemo(() => {
		const columns = autoColumns(tiles.length, size.width, size.height);
		return { columns, rows: autoVisibleRows(tiles.length, columns) };
	}, [tiles.length, size.width, size.height]);
	const { columns, rows } = grid.preset === "auto" ? autoShape : grid.preset;
	const shape = gridShape(tiles.length, columns, rows);

	// Divider drags live locally until mouseup, then persist once.
	const [dragCols, setDragCols] = useState<number[] | null>(null);
	const [dragRows, setDragRows] = useState<number[] | null>(null);
	const colRatios =
		dragCols ?? normalizeRatios(grid.colRatios ?? undefined, columns);
	const rowRatios =
		dragRows ?? normalizeRatios(grid.rowRatios ?? undefined, rows);

	const rowHeights = useMemo(() => {
		const h = size.height;
		return Array.from({ length: shape.totalRows }, (_, i) =>
			i < rows ? h * rowRatios[i] : h / rows,
		);
	}, [size.height, shape.totalRows, rows, rowRatios]);

	// ── Focused tile: keep it on a live tile. ──
	const lastIndexRef = useRef(0);
	useEffect(() => {
		const store = useWindowUiStore.getState();
		const idx = tiles.findIndex((t) => t.paneId === focusedTileId);
		if (idx >= 0) {
			lastIndexRef.current = idx;
			return;
		}
		if (tiles.length === 0) {
			if (focusedTileId !== null) store.setFocusedTile(null);
			return;
		}
		// First open: start where the Workspace view was, if that is a tile.
		if (focusedTileId === null) {
			const wsFocus = useWorkspaceStore.getState().focusedPaneId;
			const hit = tiles.find((t) => t.paneId === wsFocus);
			store.setFocusedTile(hit ? hit.paneId : tiles[0].paneId);
			return;
		}
		// The focused agent left the grid: take its neighbour's place.
		const next = tiles[Math.min(lastIndexRef.current, tiles.length - 1)];
		store.setFocusedTile(next.paneId);
	}, [tiles, focusedTileId]);

	// A just-started Agent is shown before it reaches agent mode (see
	// `alsoShow`). Stop forcing it once it gets there — from then on it is a
	// tile on its own merits — or once it has had long enough to.
	const pendingTile = useWindowUiStore((s) => s.pendingTile);
	const pendingIsAgent = usePtyActivityStore((s) => {
		if (!pendingTile) return false;
		const ptyId = s.panePtyMap[pendingTile.paneId];
		return !!ptyId && s.activities[ptyId]?.detectionMode === "agent";
	});
	useEffect(() => {
		if (!pendingTile) return;
		const clear = () => {
			if (useWindowUiStore.getState().pendingTile === pendingTile) {
				useWindowUiStore.setState({ pendingTile: null });
			}
		};
		if (pendingIsAgent) {
			clear();
			return;
		}
		const left = PENDING_TILE_MS - (Date.now() - pendingTile.at);
		const timer = setTimeout(clear, Math.max(0, left));
		return () => clearTimeout(timer);
	}, [pendingTile, pendingIsAgent]);

	// The spotlighted agent left the fleet: back to the grid.
	useEffect(() => {
		if (spotlightTileId && !spotlight) {
			useWindowUiStore.getState().setSpotlight(null);
		}
	}, [spotlightTileId, spotlight]);

	// Keyboard moves walk the grid as drawn.
	useEffect(() => {
		publishFleetGrid(
			tiles.map((t) => t.paneId),
			columns,
		);
	}, [tiles, columns]);

	// Scroll the focused tile into view (keyboard moves, notification clicks).
	useEffect(() => {
		if (!focusedTileId) return;
		const el = scrollRef.current?.querySelector(
			`[data-fleet-tile="${CSS.escape(focusedTileId)}"]`,
		);
		el?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [focusedTileId]);

	// Leaving the console hands every terminal back; refocus the Workspace
	// view's pane so typing keeps going somewhere visible.
	useEffect(
		() => () => {
			const id = useWorkspaceStore.getState().focusedPaneId;
			if (id) getTerminal(id)?.term.focus();
		},
		[],
	);

	const wsById = useMemo(
		() => new Map(workspaces.map((w) => [w.id, w])),
		[workspaces],
	);
	const workspaceCount = new Set(tiles.map((t) => t.workspaceId)).size;

	// ── Divider dragging ──
	const gridRef = useRef<HTMLDivElement>(null);
	const startDrag = useCallback(
		(axis: "col" | "row", index: number, e: React.MouseEvent) => {
			e.preventDefault();
			const start = axis === "col" ? e.clientX : e.clientY;
			const whole = axis === "col" ? size.width : size.height;
			const base = axis === "col" ? colRatios : rowRatios;
			if (whole <= 0) return;
			let latest = base;
			const onMove = (ev: MouseEvent) => {
				const pos = axis === "col" ? ev.clientX : ev.clientY;
				latest = dragDivider(base, index, (pos - start) / whole);
				if (axis === "col") setDragCols(latest);
				else setDragRows(latest);
			};
			const onUp = () => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				document.body.style.cursor = "";
				const s = useWindowUiStore.getState().fleetGrid;
				if (axis === "col") setFleetRatios(latest, s.rowRatios);
				else setFleetRatios(s.colRatios, latest);
				setDragCols(null);
				setDragRows(null);
			};
			document.body.style.cursor = axis === "col" ? "col-resize" : "row-resize";
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		},
		[size.width, size.height, colRatios, rowRatios, setFleetRatios],
	);

	// ── Spotlight layout: the spotlighted tile on the left, spanning the
	// visible height, and the Filmstrip in one scrolling column beside it. The
	// same grid element as the grid layout, so no terminal remounts on a switch.
	const [dragFilm, setDragFilm] = useState<number | null>(null);
	const filmRatio = dragFilm ?? grid.filmstripRatio;
	const filmRows = Math.max(3, tiles.length); // others + the New agent tile
	const startFilmDrag = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			const start = e.clientX;
			const base = grid.filmstripRatio;
			if (size.width <= 0) return;
			let latest = base;
			const onMove = (ev: MouseEvent) => {
				latest = Math.min(
					0.5,
					Math.max(0.12, base - (ev.clientX - start) / size.width),
				);
				setDragFilm(latest);
			};
			const onUp = () => {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				document.body.style.cursor = "";
				setFilmstripRatio(latest);
				setDragFilm(null);
			};
			document.body.style.cursor = "col-resize";
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		},
		[grid.filmstripRatio, size.width, setFilmstripRatio],
	);

	// Positional cells and dividers: their identity *is* their position.
	const colEdges = cumulative(colRatios)
		.slice(0, -1)
		.map((at, index) => ({ id: `col-${index}`, at, index }));
	const rowEdges = cumulative(rowRatios)
		.slice(0, -1)
		.map((f, index) => ({ id: `row-${index}`, at: f * size.height, index }));
	const freeCellIds = Array.from({ length: shape.freeCells }, (_, n) =>
		n === 0 ? "new-agent" : `free-${n}`,
	);

	return (
		<div
			data-fleet-console
			className="absolute flex flex-col"
			style={{
				top: topOffset,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 25,
				background: "var(--ambient-glow-top), var(--bg-primary)",
			}}
		>
			<div
				className="flex items-center shrink-0 select-none"
				style={{
					height: TOOLBAR_HEIGHT,
					padding: "0 12px 0 14px",
					gap: 12,
					borderBottom:
						"1px solid color-mix(in srgb, var(--border) 60%, transparent)",
				}}
			>
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 10.5,
						fontWeight: 600,
						letterSpacing: "0.16em",
						textTransform: "uppercase",
						color: "var(--accent)",
					}}
				>
					Fleet
				</span>
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 11,
						color: "var(--fg-secondary)",
					}}
				>
					{tiles.length === 0
						? "no running agents"
						: `${tiles.length} agent${tiles.length === 1 ? "" : "s"} · ${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"}`}
				</span>
				<div
					className="flex items-center"
					style={{ marginLeft: "auto", gap: 8 }}
				>
					<ZoomSlider zoom={grid.zoom} onChange={setTileZoom} />
					<GridPicker
						preset={grid.preset}
						autoShape={autoShape}
						onChange={setFleetPreset}
					/>
					<button
						type="button"
						onClick={() => setNewAgentOpen(true)}
						className="flex items-center text-[var(--fg-primary)] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_28%,transparent)]"
						style={{
							height: 24,
							padding: "0 10px 0 8px",
							gap: 5,
							borderRadius: 5,
							border:
								"1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
							fontSize: 11.5,
							cursor: "pointer",
							transition: "background 120ms ease",
						}}
					>
						<Plus size={13} />
						New agent
					</button>
				</div>
			</div>
			<div className="flex-1 min-h-0 relative flex flex-col">
				{/* The Filmstrip divider sits outside the scrolling grid, so it stays
			    beside the pinned spotlight while the Filmstrip scrolls. */}
				{spotlight && (
					<Divider
						axis="col"
						style={{
							left: `calc(${(1 - filmRatio) * 100}% - ${DIVIDER_HIT / 2}px)`,
						}}
						onMouseDown={startFilmDrag}
					/>
				)}
				<div
					ref={scrollRef}
					className="flex-1 min-h-0 relative"
					style={{ overflowY: "auto", overflowX: "hidden", padding: 0 }}
				>
					{size.height > 0 && (
						<div
							ref={gridRef}
							className="relative"
							style={{
								display: "grid",
								...(spotlight
									? {
											gridTemplateColumns: `${1 - filmRatio}fr ${filmRatio}fr`,
											gridTemplateRows: `repeat(${filmRows}, ${size.height / 3}px)`,
										}
									: {
											gridTemplateColumns: colRatios
												.map((r) => `${r}fr`)
												.join(" "),
											gridTemplateRows: rowHeights
												.map((h) => `${h}px`)
												.join(" "),
										}),
							}}
						>
							{tiles.map((t, i) => {
								const ws = wsById.get(t.workspaceId);
								return (
									<FleetTile
										key={t.paneId}
										paneId={t.paneId}
										ptyId={t.ptyId}
										workspaceName={ws?.name ?? ""}
										branch={
											gitById[t.workspaceId]?.currentBranch ??
											ws?.lastBranch ??
											null
										}
										tabName={t.tabName}
										isFocused={t.paneId === focusedTileId}
										index={i}
										placement={
											!spotlight
												? "grid"
												: t.paneId === spotlight
													? "spotlight"
													: "filmstrip"
										}
										// The spotlighted agent reads like the Workspace view.
										fontScale={t.paneId === spotlight ? 1 : grid.zoom}
									/>
								);
							})}
							{spotlight ? (
								<NewAgentCell
									key="new-agent"
									empty={false}
									inFilmstrip
									onClick={() => setNewAgentOpen(true)}
								/>
							) : (
								freeCellIds.map((id) =>
									id === "new-agent" ? (
										<NewAgentCell
											key={id}
											empty={tiles.length === 0}
											onClick={() => setNewAgentOpen(true)}
										/>
									) : (
										<EmptyCell key={id} />
									),
								)
							)}
							{!spotlight &&
								colEdges.map((edge) => (
									<Divider
										key={edge.id}
										axis="col"
										style={{
											left: `calc(${edge.at * 100}% - ${DIVIDER_HIT / 2}px)`,
										}}
										onMouseDown={(e) => startDrag("col", edge.index, e)}
									/>
								))}
							{!spotlight &&
								rowEdges.map((edge) => (
									<Divider
										key={edge.id}
										axis="row"
										style={{ top: edge.at - DIVIDER_HIT / 2 }}
										onMouseDown={(e) => startDrag("row", edge.index, e)}
									/>
								))}
						</div>
					)}
				</div>
			</div>
			{newAgentOpen && (
				<NewAgentDialog onClose={() => setNewAgentOpen(false)} />
			)}
		</div>
	);
}

function cumulative(ratios: number[]): number[] {
	let acc = 0;
	return ratios.map((r) => {
		acc += r;
		return acc;
	});
}

function Divider({
	axis,
	style,
	onMouseDown,
}: {
	axis: "col" | "row";
	style: React.CSSProperties;
	onMouseDown: (e: React.MouseEvent) => void;
}) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize handle, like PaneResizer
		<div
			className="fleet-divider absolute z-10"
			data-axis={axis}
			onMouseDown={onMouseDown}
			style={{
				...(axis === "col"
					? { top: 0, bottom: 0, width: DIVIDER_HIT, cursor: "col-resize" }
					: { left: 0, right: 0, height: DIVIDER_HIT, cursor: "row-resize" }),
				...style,
			}}
		/>
	);
}

function NewAgentCell({
	empty,
	inFilmstrip,
	onClick,
}: {
	empty: boolean;
	/** At the end of the Filmstrip rather than in a grid cell. */
	inFilmstrip?: boolean;
	onClick: () => void;
}) {
	return (
		<div
			style={{
				padding: 3,
				minWidth: 0,
				minHeight: 0,
				...(inFilmstrip ? { gridColumn: 2 } : {}),
			}}
		>
			<button
				type="button"
				onClick={onClick}
				className="fleet-new-agent group w-full h-full flex flex-col items-center justify-center text-[var(--fg-secondary)] hover:text-[var(--accent)]"
				style={{
					gap: 8,
					borderRadius: 7,
					cursor: "pointer",
					transition: "color 140ms ease",
				}}
			>
				<span
					className="flex items-center justify-center"
					style={{
						width: 34,
						height: 34,
						borderRadius: 999,
						border: "1px solid currentColor",
					}}
				>
					<Plus size={16} />
				</span>
				<span style={{ fontSize: 12 }}>New agent</span>
				{empty && (
					<span
						style={{
							fontSize: 11,
							opacity: 0.6,
							maxWidth: 260,
							textAlign: "center",
						}}
					>
						No agents are running in this window's opened workspaces.
					</span>
				)}
			</button>
		</div>
	);
}

function EmptyCell() {
	return (
		<div style={{ padding: 3, minWidth: 0, minHeight: 0 }}>
			<div
				className="w-full h-full"
				style={{
					borderRadius: 7,
					border:
						"1px dashed color-mix(in srgb, var(--border) 45%, transparent)",
				}}
			/>
		</div>
	);
}

/** The **Tile zoom** slider: 50–100% in 5% steps. Double-click resets. */
function ZoomSlider({
	zoom,
	onChange,
}: {
	zoom: number;
	onChange: (zoom: number) => void;
}) {
	return (
		<label
			className="flex items-center select-none"
			title="Tile zoom — text size in the tiles (Cmd/Ctrl + / −, Cmd/Ctrl+0 resets). Double-click to reset."
			style={{ gap: 7, color: "var(--fg-secondary)" }}
			onDoubleClick={() => onChange(TILE_ZOOM_DEFAULT)}
		>
			<ZoomIn size={12} />
			<input
				type="range"
				aria-label="Tile zoom"
				min={TILE_ZOOM_MIN}
				max={TILE_ZOOM_MAX}
				step={TILE_ZOOM_STEP}
				value={zoom}
				onChange={(e) => onChange(Number(e.target.value))}
				className="fleet-zoom"
				style={{ width: 92 }}
			/>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					minWidth: 32,
					textAlign: "right",
				}}
			>
				{Math.round(zoom * 100)}%
			</span>
		</label>
	);
}
