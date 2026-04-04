import { memo } from "react";
import { useSplitPane } from "../../hooks/useSplitPane";
import type { PaneNode } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneResizer } from "./PaneResizer";
import { TerminalSlot } from "./TerminalSlot";

interface Props {
	node: PaneNode;
	cwd: string;
}

/** Leaf component for terminal nodes — subscribes to focus/maximize state. */
const TerminalLeaf = memo(function TerminalLeaf({
	nodeId,
}: {
	nodeId: string;
}) {
	const focusedPaneId = useSessionStore((s) => s.focusedPaneId);
	const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
	const maximizedPaneId = useSessionStore((s) => s.maximizedPaneId);
	const { splitPane, closePane, toggleMaximize } = useSplitPane();

	return (
		<TerminalSlot
			paneId={nodeId}
			isFocused={focusedPaneId === nodeId}
			isMaximized={maximizedPaneId === nodeId}
			onFocus={() => setFocusedPane(nodeId)}
			onSplitHorizontal={() => splitPane(nodeId, "horizontal")}
			onSplitVertical={() => splitPane(nodeId, "vertical")}
			onClose={() => closePane(nodeId)}
			onMaximize={toggleMaximize}
		/>
	);
});

/** Split node — only handles layout, no store subscriptions for focus/maximize. */
function SplitNode({
	node,
	cwd,
}: {
	node: PaneNode & { type: "split" };
	cwd: string;
}) {
	const { updateRatioLocal, persistCurrentLayout } = useSplitPane();
	const isVertical = node.direction === "vertical";
	const RESIZER_PX = 4;
	const firstBasis = `calc(${node.ratio * 100}% - ${RESIZER_PX / 2}px)`;
	const secondBasis = `calc(${(1 - node.ratio) * 100}% - ${RESIZER_PX / 2}px)`;

	return (
		<div
			className="flex w-full h-full"
			style={{ flexDirection: isVertical ? "row" : "column" }}
		>
			<div
				style={{
					flexBasis: firstBasis,
					flexGrow: 0,
					flexShrink: 0,
					overflow: "hidden",
				}}
			>
				<SplitContainer key={node.first.id} node={node.first} cwd={cwd} />
			</div>
			<PaneResizer
				direction={node.direction}
				onResizeEnd={(ratio) => {
					updateRatioLocal(node.id, ratio);
					persistCurrentLayout();
				}}
			/>
			<div
				style={{
					flexBasis: secondBasis,
					flexGrow: 0,
					flexShrink: 0,
					overflow: "hidden",
				}}
			>
				<SplitContainer key={node.second.id} node={node.second} cwd={cwd} />
			</div>
		</div>
	);
}

export function SplitContainer({ node, cwd }: Props) {
	if (node.type === "terminal") {
		return <TerminalLeaf nodeId={node.id} />;
	}

	return <SplitNode node={node} cwd={cwd} />;
}
