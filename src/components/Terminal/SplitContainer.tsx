import { lazy, memo, Suspense } from "react";
import { useSplitPane } from "../../hooks/useSplitPane";
import type { PaneNode } from "../../lib/types";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FilePane } from "../FileViewer/FilePane";
import { PaneResizer } from "./PaneResizer";
import { TerminalSlot } from "./TerminalSlot";

const LazyPreviewPane = lazy(() =>
	import("../FileViewer/PreviewPane").then((m) => ({ default: m.PreviewPane })),
);

interface Props {
	node: PaneNode;
	cwd: string;
	/** The owning Workspace. Threaded explicitly rather than reverse-looked-up
	 *  from `cwd`, so a pane always reads its *own* workspace's state — hidden
	 *  background workspaces stay mounted (ADR-0002). */
	workspaceId: string;
}

/** Leaf component for terminal nodes — subscribes to focus state. */
const TerminalLeaf = memo(function TerminalLeaf({
	nodeId,
	agentId,
}: {
	nodeId: string;
	agentId?: string;
}) {
	const isFocused = useWorkspaceStore((s) => s.focusedPaneId === nodeId);
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);
	const { splitPaneWithPicker, closePane } = useSplitPane();

	return (
		<TerminalSlot
			paneId={nodeId}
			agentId={agentId}
			isFocused={isFocused}
			onFocus={() => setFocusedPane(nodeId)}
			onSplitHorizontal={() => splitPaneWithPicker(nodeId, "horizontal")}
			onSplitVertical={() => splitPaneWithPicker(nodeId, "vertical")}
			onClose={() => closePane(nodeId)}
		/>
	);
});

/** Leaf component for file nodes. */
const FileLeaf = memo(function FileLeaf({
	node,
	cwd,
	workspaceId,
}: {
	node: PaneNode & { type: "file" };
	cwd: string;
	workspaceId: string;
}) {
	const isFocused = useWorkspaceStore((s) => s.focusedPaneId === node.id);
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);

	return (
		<FilePane
			paneId={node.id}
			filePath={node.filePath}
			cwd={cwd}
			workspaceId={workspaceId}
			isDiff={node.isDiff}
			diffSection={node.diffSection}
			isDeleted={node.isDeleted}
			isFocused={isFocused}
			onFocus={() => setFocusedPane(node.id)}
		/>
	);
});

/** Leaf component for preview nodes. */
const PreviewLeaf = memo(function PreviewLeaf({
	node,
}: {
	node: PaneNode & { type: "preview" };
}) {
	const setFocusedPane = useWorkspaceStore((s) => s.setFocusedPane);

	return (
		<Suspense fallback={null}>
			<LazyPreviewPane
				paneId={node.id}
				sourcePaneId={node.sourcePaneId}
				onFocus={() => setFocusedPane(node.id)}
			/>
		</Suspense>
	);
});

/** Split node — only handles layout, no store subscriptions. */
function SplitNode({
	node,
	cwd,
	workspaceId,
}: {
	node: PaneNode & { type: "split" };
	cwd: string;
	workspaceId: string;
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
				<SplitContainer
					key={node.first.id}
					node={node.first}
					cwd={cwd}
					workspaceId={workspaceId}
				/>
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
				<SplitContainer
					key={node.second.id}
					node={node.second}
					cwd={cwd}
					workspaceId={workspaceId}
				/>
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

export function SplitContainer({ node, cwd, workspaceId }: Props) {
	if (node.type === "terminal") {
		return <TerminalLeaf nodeId={node.id} agentId={node.agentId} />;
	}
	if (node.type === "file") {
		return <FileLeaf node={node} cwd={cwd} workspaceId={workspaceId} />;
	}
	if (node.type === "preview") {
		return <PreviewLeaf node={node} />;
	}
	if (node.type === "split") {
		return <SplitNode node={node} cwd={cwd} workspaceId={workspaceId} />;
	}
	return <UnknownPaneFallback type={(node as { type?: string }).type} />;
}
