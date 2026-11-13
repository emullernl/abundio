import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { switchToPane } from "../../lib/paneLocation";
import { getTerminal, setPaneFontScale } from "../../lib/terminalManager";
import { requestPaneClose } from "../../stores/paneCloseConfirmStore";
import {
	computePtyDotStatus,
	type DotStatus,
	usePtyActivityStore,
} from "../../stores/ptyActivityStore";
import { useWindowUiStore } from "../../stores/windowUiStore";
import { DOT_STATUS_COLOR } from "../AgentStatusIcon";
import { FocusSweep } from "../Terminal/FocusSweep";
import { TerminalSlot } from "../Terminal/TerminalSlot";

/** Statuses that want the user: the tile's edge lights up for these, so a
 *  Waiting or finished agent is found by eye in a full grid. The same set that
 *  earns an OS notification. */
const ATTENTION: ReadonlySet<DotStatus> = new Set(["red", "skyblue", "purple"]);

/** Where the tile sits: in the grid, in the Spotlight slot, or in the
 *  Filmstrip beside it. */
export type TilePlacement = "grid" | "spotlight" | "filmstrip";

interface Props {
	paneId: string;
	ptyId: string;
	agentId?: string;
	workspaceName: string;
	branch: string | null;
	tabName: string;
	isFocused: boolean;
	/** Position in the grid, for the staggered entrance. */
	index: number;
	placement: TilePlacement;
	/** Font scale: the **Tile zoom**, or 1 in the Spotlight slot. */
	fontScale: number;
	/** The Console's visible height: the spotlighted tile's own height. */
	viewportHeight: number;
	/** False while the Console is still bringing tiles in: the cell holds its
	 *  place and shows where the agent lives, but the pane is not borrowed yet
	 *  — its terminal stays in the Workspace view, at its normal size. */
	live: boolean;
}

/**
 * One **Fleet tile**: the pane itself, borrowed from its Workspace layout
 * (ADR-0040), framed with a status-coloured edge.
 */
export const FleetTile = memo(function FleetTile({
	paneId,
	ptyId,
	agentId,
	workspaceName,
	branch,
	tabName,
	isFocused,
	index,
	placement,
	fontScale,
	viewportHeight,
	live,
}: Props) {
	const status = usePtyActivityStore((s) =>
		computePtyDotStatus(getTerminal(paneId)?.ptyId || ptyId, s.activities),
	);
	const color = DOT_STATUS_COLOR[status];
	const attention = ATTENTION.has(status);

	// Draw at the zoom while borrowed; hand the pane back at its normal size.
	// Two effects, so a zoom change is one reflow rather than reset-then-set.
	//
	// Borrowing and handing back each move the terminal between containers,
	// and that move fits it and resizes its PTY once by itself. So at those two
	// moments the font changes without a refit of its own (`refit: false`),
	// or the program would reflow twice — once for a size nobody sees. Only a
	// zoom change while the tile stays put refits here.
	const appliedRef = useRef(false);
	useEffect(() => {
		if (!live) return;
		setPaneFontScale(paneId, fontScale, { refit: appliedRef.current });
		appliedRef.current = true;
	}, [paneId, fontScale, live]);
	useEffect(() => {
		if (!live) return;
		return () => {
			appliedRef.current = false;
			setPaneFontScale(paneId, null, { refit: false });
		};
	}, [paneId, live]);

	const onFocus = useCallback(
		() => useWindowUiStore.getState().setFocusedTile(paneId),
		[paneId],
	);
	const onClose = useCallback(
		() => requestPaneClose(paneId, `${workspaceName} · ${tabName}`),
		[paneId, workspaceName, tabName],
	);
	const spotlighted = placement === "spotlight";
	const fleet = useMemo(
		() => ({
			workspaceName,
			branch,
			tabName,
			onSwitchTo: () => switchToPane(paneId),
			spotlighted,
			onToggleSpotlight: () => {
				const ui = useWindowUiStore.getState();
				ui.setSpotlight(spotlighted ? null : paneId);
				ui.setFocusedTile(paneId);
			},
		}),
		[workspaceName, branch, tabName, paneId, spotlighted],
	);

	return (
		<div
			data-fleet-tile={paneId}
			data-placement={placement}
			className="fleet-tile-enter"
			style={{
				padding: 3,
				minWidth: 0,
				minHeight: 0,
				animationDelay: `${Math.min(index, 12) * 28}ms`,
				...(spotlighted
					? {
							gridColumn: 1,
							// Stays put while the Filmstrip beside it scrolls. A grid
							// item's sticky range is its grid area, so the area spans
							// every row and the tile is one viewport tall inside it —
							// an area only as tall as the tile leaves sticky nowhere
							// to travel (Chromium is lenient here; the spec, and so
							// possibly WebKit, is not).
							gridRow: "1 / -1",
							position: "sticky",
							top: 0,
							height: viewportHeight,
						}
					: placement === "filmstrip"
						? { gridColumn: 2 }
						: {}),
			}}
		>
			<div
				className="relative flex h-full w-full"
				style={{
					borderRadius: 7,
					overflow: "hidden",
					background:
						"color-mix(in srgb, var(--bg-secondary) 28%, transparent)",
					border: `1px solid ${
						isFocused
							? "color-mix(in srgb, var(--accent) 70%, transparent)"
							: attention
								? `color-mix(in srgb, ${color} 45%, transparent)`
								: "color-mix(in srgb, var(--border) 80%, transparent)"
					}`,
					// The status edge: a 3px bar down the left, always present, so
					// colour alone locates an agent. Attention states add a soft
					// outer glow.
					boxShadow: `inset 3px 0 0 ${color}${
						attention
							? `, 0 0 0 1px color-mix(in srgb, ${color} 18%, transparent), 0 0 18px -6px ${color}`
							: ""
					}`,
					transition: "border-color 160ms ease, box-shadow 220ms ease",
				}}
			>
				{!live ? (
					<TilePlaceholder workspaceName={workspaceName} tabName={tabName} />
				) : (
					<div className="flex-1 min-w-0 min-h-0" style={{ paddingLeft: 3 }}>
						<TerminalSlot
							paneId={paneId}
							agentId={agentId}
							fleet={fleet}
							isFocused={isFocused}
							onFocus={onFocus}
							onSplitHorizontal={noop}
							onSplitVertical={noop}
							onClose={onClose}
						/>
					</div>
				)}
				{/* Above the terminal canvas, inside the tile's rounded frame. */}
				<FocusSweep paneId={paneId} inFleetTile />
			</div>
		</div>
	);
});

function noop() {}

/** A tile not brought in yet: where the agent lives, dimmed, in the frame it
 *  will fill. */
function TilePlaceholder({
	workspaceName,
	tabName,
}: {
	workspaceName: string;
	tabName: string;
}) {
	return (
		<div
			className="flex-1 flex flex-col select-none"
			style={{ padding: "6px 12px", gap: 4 }}
		>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 11.5,
					fontWeight: 600,
					color: "var(--fg-secondary)",
					opacity: 0.55,
				}}
			>
				{workspaceName}
			</span>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: 10.5,
					color: "var(--fg-secondary)",
					opacity: 0.35,
				}}
			>
				{tabName}
			</span>
		</div>
	);
}
