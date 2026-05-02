import { memo } from "react";
import { useSplitPane } from "../../hooks/useSplitPane";
import type { PaneNode } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FilePane } from "../FileViewer/FilePane";
import { PaneResizer } from "./PaneResizer";
import { TerminalSlot } from "./TerminalSlot";

interface Props {
	node: PaneNode;
	cwd: string;
}

/** Leaf component for terminal nodes — subscribes to focus/maximize state. */
const TerminalLeaf = memo(function TerminalLeaf({
	nodeId,
	agentId,
}: {
	nodeId: string;
	agentId?: string;
}) {
	const focusedPaneId = useWorkspaceStore((s) => s.focusedPaneId);
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);
	const maximizedPaneId = useWorkspaceStore((s) => s.maximizedPaneId);
	const { splitPaneWithPicker, closePane, toggleMaximize } = useSplitPane();

	return (
		<TerminalSlot
			paneId={nodeId}
			agentId={agentId}
			isFocused={focusedPaneId === nodeId}
			isMaximized={maximizedPaneId === nodeId}
			onFocus={() => setFocusedPane(nodeId)}
			onSplitHorizontal={() => splitPaneWithPicker(nodeId, "horizontal")}
			onSplitVertical={() => splitPaneWithPicker(nodeId, "vertical")}
			onClose={() => closePane(nodeId)}
			onMaximize={toggleMaximize}
		/>
	);
});

/** Leaf component for file nodes. */
const FileLeaf = memo(function FileLeaf({
	node,
}: {
	node: PaneNode & { type: "file" };
}) {
	const focusedPaneId = useWorkspaceStore((s) => s.focusedPaneId);
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);

	return (
		<FilePane
			paneId={node.id}
			filePath={node.filePath}
			isDiff={node.isDiff}
			diffSection={node.diffSection}
			isFocused={focusedPaneId === node.id}
			onFocus={() => setFocusedPane(node.id)}
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

function UnknownPaneFallback({ type }: { type?: string }) {
	return (
		<div
			className="flex items-center justify-center w-full h-full"
			style={{
				backgroundColor: "var(--bg-primary)",
				color: "var(--fg-secondary)",
				fontSize: 12,
			}}
		>
			Unsupported pane type: {type ?? "(none)"}
		</div>
	);
}

export function SplitContainer({ node, cwd }: Props) {
	if (node.type === "terminal") {
		return <TerminalLeaf nodeId={node.id} agentId={node.agentId} />;
	}
	if (node.type === "file") {
		return <FileLeaf node={node} />;
	}
	if (node.type === "split") {
		return <SplitNode node={node} cwd={cwd} />;
	}
	return <UnknownPaneFallback type={(node as { type?: string }).type} />;
}
