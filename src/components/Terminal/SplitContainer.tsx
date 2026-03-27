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
	const { focusedPaneId, setFocusedPane, maximizedPaneId } = useSessionStore();
	const { updateRatioLocal, persistCurrentLayout, splitPane, closePane, toggleMaximize } =
		useSplitPane();

	if (node.type === "terminal") {
		return (
			<TerminalPane
				paneId={node.id}
				ptyId={node.ptyId}
				cwd={cwd}
				isFocused={focusedPaneId === node.id}
				isMaximized={maximizedPaneId === node.id}
				onFocus={() => setFocusedPane(node.id)}
				onSplitHorizontal={() => splitPane(node.id, "horizontal")}
				onSplitVertical={() => splitPane(node.id, "vertical")}
				onClose={() => closePane(node.id)}
				onMaximize={toggleMaximize}
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
				onResize={(ratio) => updateRatioLocal(node.id, ratio)}
				onResizeEnd={persistCurrentLayout}
			/>
			<div style={{ flexBasis: secondBasis, flexGrow: 0, flexShrink: 0, overflow: "hidden" }}>
				<SplitContainer node={node.second} cwd={cwd} />
			</div>
		</div>
	);
}
