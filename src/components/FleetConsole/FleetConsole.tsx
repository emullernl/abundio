import { AnimatePresence, motion } from "framer-motion";
import { Plus, ZoomIn, ZoomOut } from "lucide-react";
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
import { publishFleetGrid, stepTileZoom } from "../../lib/fleetFocus";
import { waitForSmoothFrames } from "../../lib/focusSweep";
import { getTerminal, repaintTerminal } from "../../lib/terminalManager";
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
/** Tiles brought in per smooth-frame wait once the visible ones are in. */
const STAGGER_BATCH = 2;

/**
 * The order the Console brings tiles in: the spotlighted and focused tiles,
 * then the first `visibleCount` in grid order (what is on screen with the
 * grid scrolled to the top), then the rest. Exported for tests.
 */
export function stagingOrder(
	paneIds: string[],
	focused: string | null,
	spotlight: string | null,
	visibleCount: number,
): { first: string[]; rest: string[] } {
	const first: string[] = [];
	const add = (id: string | null) => {
		if (id && paneIds.includes(id) && !first.includes(id)) first.push(id);
	};
	add(spotlight);
	add(focused);
	for (const id of paneIds.slice(0, Math.max(0, visibleCount))) add(id);
	return { first, rest: paneIds.filter((id) => !first.includes(id)) };
}

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

	// ── Opening: paint first, then mount. ──
	// Mounting every tile moves each terminal in, refits it, resizes its PTY,
	// applies the zoom and swaps its renderer — enough work that, done in the
	// click's own frame, nothing appears until all of it is finished. So the
	// Console paints its toolbar and a loader first ("shell"), mounts the tiles
	// two frames later ("mounting"), and drops the loader once frames are
	// flowing smoothly again ("ready") — the same wait the Focus sweep uses.
	const [phase, setPhase] = useState<"shell" | "mounting" | "ready">("shell");
	useEffect(() => {
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setPhase("mounting"));
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, []);
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

	// ── Staggered mount: visible tiles first. ──
	// "mounting" brings in what is on screen (plus the focused and spotlighted
	// tiles, wherever they are); the loader drops once those have settled. The
	// rest follow a couple at a time, each batch waiting for smooth frames
	// again, so the Console is usable while the off-screen tiles load.
	const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(() => new Set());
	// Mirror of `liveIds` for the batch loop, which runs outside render.
	const liveRef = useRef<ReadonlySet<string>>(liveIds);
	const [staged, setStaged] = useState(false);
	const tileOrder = useMemo(
		() =>
			stagingOrder(
				tiles.map((t) => t.paneId),
				focusedTileId,
				spotlight,
				spotlight ? 4 : columns * rows,
			),
		[tiles, focusedTileId, spotlight, columns, rows],
	);
	const orderRef = useRef(tileOrder);
	orderRef.current = tileOrder;
	// Tiles come in STAGGER_BATCH at a time, one batch per smooth stretch of
	// frames — the visible ones first. No batch is a long task, so the loader
	// keeps animating between them. The loader drops once every visible tile
	// is in ("ready"); the off-screen ones keep arriving behind it.
	useEffect(() => {
		if (phase === "shell" || staged) return;
		let cancel = () => {};
		const step = () => {
			const { first, rest } = orderRef.current;
			const next = new Set(liveRef.current);
			for (const id of [...first, ...rest]) {
				if (next.size - liveRef.current.size >= STAGGER_BATCH) break;
				next.add(id);
			}
			if (next.size !== liveRef.current.size) {
				liveRef.current = next;
				setLiveIds(next);
			}
			const visibleIn = first.every((id) => next.has(id));
			if (phase === "mounting") {
				if (visibleIn) {
					// Let the last visible batch paint, then drop the loader. The
					// effect re-runs for "ready" and carries on with the rest.
					cancel = waitForSmoothFrames(() => setPhase("ready"));
					return;
				}
			} else if (rest.every((id) => next.has(id))) {
				setStaged(true);
				return;
			}
			cancel = waitForSmoothFrames(step);
		};
		// The first batch goes in on the next frame, so the loader has painted.
		const frame = requestAnimationFrame(step);
		return () => {
			cancelAnimationFrame(frame);
			cancel();
		};
	}, [phase, staged]);
	/** Whether a tile's pane is borrowed yet. Once staging is done every tile
	 *  is; the focused and spotlighted tiles always are, so a keyboard move
	 *  or a notification click never lands on a placeholder. */
	const isLive = (paneId: string) =>
		staged ||
		liveIds.has(paneId) ||
		paneId === focusedTileId ||
		paneId === spotlight;

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
			if (!id) return;
			getTerminal(id)?.term.focus();
			// And redraw it, as gaining focus would have: the pane was just
			// handed back, refitted, re-zoomed and given its WebGL context again,
			// and output that arrived meanwhile can sit in the buffer undrawn.
			// Two frames, so the hand-back's own fit has landed first.
			requestAnimationFrame(() =>
				requestAnimationFrame(() => repaintTerminal(id)),
			);
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
					{size.height > 0 && phase !== "shell" && (
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
										live={isLive(t.paneId)}
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
				<AnimatePresence>
					{phase !== "ready" && (
						<ConsoleLoader key="loader" agents={tiles.length} />
					)}
				</AnimatePresence>
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

/** The **Tile zoom** control: − button, slider, + button, 50–100% in 5%
 *  steps. Double-click the slider or the percentage to reset to 75%. */
function ZoomSlider({
	zoom,
	onChange,
}: {
	zoom: number;
	onChange: (zoom: number) => void;
}) {
	const reset = () => onChange(TILE_ZOOM_DEFAULT);
	return (
		<div
			className="flex items-center select-none"
			style={{ gap: 4, color: "var(--fg-secondary)" }}
		>
			<ZoomButton
				icon={ZoomOut}
				label="Zoom out tiles (Cmd/Ctrl + −)"
				disabled={zoom <= TILE_ZOOM_MIN}
				onClick={() => stepTileZoom(-1)}
			/>
			<input
				type="range"
				aria-label="Tile zoom"
				title="Tile zoom — text size in the tiles. Double-click to reset to 75%."
				min={TILE_ZOOM_MIN}
				max={TILE_ZOOM_MAX}
				step={TILE_ZOOM_STEP}
				value={zoom}
				onChange={(e) => onChange(Number(e.target.value))}
				onDoubleClick={reset}
				className="fleet-zoom"
				style={{ width: 92 }}
			/>
			<ZoomButton
				icon={ZoomIn}
				label="Zoom in tiles (Cmd/Ctrl + =)"
				disabled={zoom >= TILE_ZOOM_MAX}
				onClick={() => stepTileZoom(1)}
			/>
			<button
				type="button"
				onClick={reset}
				title="Reset to 75% (Cmd/Ctrl+0)"
				className="hover:text-[var(--fg-primary)]"
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11,
					minWidth: 34,
					textAlign: "right",
					cursor: "pointer",
				}}
			>
				{Math.round(zoom * 100)}%
			</button>
		</div>
	);
}

function ZoomButton({
	icon: Icon,
	label,
	disabled,
	onClick,
}: {
	icon: typeof ZoomIn;
	label: string;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="flex items-center justify-center rounded enabled:hover:text-[var(--fg-primary)] enabled:hover:bg-[var(--bg-tertiary)] disabled:opacity-35"
			style={{
				width: 22,
				height: 22,
				cursor: disabled ? "default" : "pointer",
				transition: "background 120ms ease, color 120ms ease",
			}}
		>
			<Icon size={13} />
		</button>
	);
}

/** Covers the grid while the Console mounts its tiles, so opening it answers
 *  the click at once. The same bar wave a terminal shows while it starts. */
function ConsoleLoader({ agents }: { agents: number }) {
	return (
		<motion.div
			className="absolute inset-0 z-20 flex items-center justify-center select-none"
			initial={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.18, ease: "easeOut" }}
			style={{ background: "var(--ambient-glow-top), var(--bg-primary)" }}
			aria-live="polite"
		>
			<div className="flex flex-col items-center" style={{ gap: 12 }}>
				<div className="flex" style={{ gap: 3 }}>
					{[0, 1, 2, 3, 4].map((i) => (
						<div
							key={i}
							style={{
								width: 3,
								height: 16,
								borderRadius: 1,
								backgroundColor: "var(--accent)",
								opacity: 0.15,
								animation: `terminal-bar-wave 1.2s ease-in-out ${i * 0.12}s infinite`,
								// Own layer from the first frame, so the wave runs on the
								// compositor while the main thread mounts tiles.
								willChange: "transform, opacity",
							}}
						/>
					))}
				</div>
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 10.5,
						letterSpacing: "0.12em",
						textTransform: "uppercase",
						color: "var(--fg-secondary)",
						opacity: 0.6,
					}}
				>
					{agents === 0
						? "Gathering the fleet"
						: `Gathering ${agents} agent${agents === 1 ? "" : "s"}`}
				</span>
			</div>
		</motion.div>
	);
}
