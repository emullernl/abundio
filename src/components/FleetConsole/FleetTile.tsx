import { memo, useCallback, useEffect, useMemo } from "react";
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
}: Props) {
	const status = usePtyActivityStore((s) =>
		computePtyDotStatus(getTerminal(paneId)?.ptyId || ptyId, s.activities),
	);
	const color = DOT_STATUS_COLOR[status];
	const attention = ATTENTION.has(status);

	// Draw at the zoom while borrowed; hand the pane back at its normal size.
	// Two effects, so a zoom change is one reflow rather than reset-then-set.
	useEffect(() => {
		setPaneFontScale(paneId, fontScale);
	}, [paneId, fontScale]);
	useEffect(() => () => setPaneFontScale(paneId, null), [paneId]);

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
							gridRow: "1 / span 3",
							// Stays put while the Filmstrip beside it scrolls.
							position: "sticky",
							top: 0,
							height: "100%",
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
				{/* Above the terminal canvas, inside the tile's rounded frame. */}
				<FocusSweep paneId={paneId} inFleetTile />
			</div>
		</div>
	);
});

function noop() {}
