import { useSplitPane } from "../../hooks/useSplitPane";
import type { PaneNode } from "../../lib/types";
import { useSessionStore } from "../../stores/sessionStore";
import { PaneResizer } from "./PaneResizer";
import { TerminalSlot } from "./TerminalSlot";

interface Props {
	node: PaneNode;
	cwd: string;
}

export function SplitContainer({ node, cwd }: Props) {
	const focusedPaneId = useSessionStore((s) => s.focusedPaneId);
	const setFocusedPane = useSessionStore((s) => s.setFocusedPane);
	const maximizedPaneId = useSessionStore((s) => s.maximizedPaneId);
	const {
		updateRatioLocal,
		persistCurrentLayout,
		splitPane,
		closePane,
		toggleMaximize,
	} = useSplitPane();

	if (node.type === "terminal") {
		return (
			<TerminalSlot
				paneId={node.id}
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
				onResize={(ratio) => updateRatioLocal(node.id, ratio)}
				onResizeEnd={persistCurrentLayout}
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
