import type { PaneNode } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";
import { useSplitPane } from "../../hooks/useSplitPane";
import { TerminalPane } from "./TerminalPane";
import { PaneResizer } from "./PaneResizer";

interface Props {
	node: PaneNode;
	cwd: string;
}

export function SplitContainer({ node, cwd }: Props) {
	const { focusedPaneId, setFocusedPane } = useSessionStore();
	const { updateRatio } = useSplitPane();

	if (node.type === "terminal") {
		return (
			<TerminalPane
				ptyId={node.ptyId}
				cwd={cwd}
				isFocused={focusedPaneId === node.id}
				onFocus={() => setFocusedPane(node.id)}
			/>
		);
	}

	const isVertical = node.direction === "vertical";
	const firstBasis = `${node.ratio * 100}%`;
	const secondBasis = `${(1 - node.ratio) * 100}%`;

	return (
		<div
			className="flex w-full h-full"
			style={{ flexDirection: isVertical ? "row" : "column" }}
		>
			<div style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 0, overflow: "hidden" }}>
				<SplitContainer node={node.first} cwd={cwd} />
			</div>
			<PaneResizer
				direction={node.direction}
				onResize={(ratio) => updateRatio(node.id, ratio)}
			/>
			<div style={{ flexBasis: secondBasis, flexGrow: 0, flexShrink: 0, overflow: "hidden" }}>
				<SplitContainer node={node.second} cwd={cwd} />
			</div>
		</div>
	);
}
