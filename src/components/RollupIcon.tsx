import { memo } from "react";
import {
	type KindRollup,
	type RollupKind,
	rollupTooltip,
} from "../stores/ptyActivityStore";
import { AgentStatusIcon } from "./AgentStatusIcon";

interface RollupIconProps {
	kind: RollupKind;
	rollup: KindRollup | null;
	size?: number;
}

/** One **Agent rollup** or **Terminal rollup** icon, hovering to its count
 *  breakdown. Renders nothing for an absent rollup — no PTYs of that kind is
 *  shown as no icon, never as Idle (ADR-0032). */
export const RollupIcon = memo(function RollupIcon({
	kind,
	rollup,
	size,
}: RollupIconProps) {
	if (!rollup) return null;
	return (
		<span
			className="flex flex-shrink-0"
			data-rollup={kind}
			title={rollupTooltip(kind, rollup.counts)}
		>
			<AgentStatusIcon status={rollup.status} size={size} />
		</span>
	);
});
