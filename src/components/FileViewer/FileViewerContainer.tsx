import { useExplorerStore } from "../../stores/explorerStore";
import { CodeEditor } from "./CodeEditor";
import { ImageViewer } from "./ImageViewer";
import { UnsupportedFile } from "./UnsupportedFile";

export function FileViewerContainer() {
	const activeFileTabId = useExplorerStore((s) => s.activeFileTabId);
	const fileTabs = useExplorerStore((s) => s.fileTabs);
	const updateFileContent = useExplorerStore((s) => s.updateFileContent);

	const activeTab = fileTabs.find((t) => t.id === activeFileTabId);

	if (!activeTab) {
		return (
			<div
				className="flex items-center justify-center h-full w-full"
				style={{ color: "var(--fg-secondary)", backgroundColor: "var(--bg-primary)" }}
			>
				No file open
			</div>
		);
	}

	return (
		<>
			{/* Render all text file editors and toggle visibility — keeps scroll/cursor alive */}
			{fileTabs
				.filter((t) => t.fileType === "text")
				.map((t) => (
					<div
						key={t.id}
						className="absolute inset-0"
						style={{ display: t.id === activeFileTabId ? "block" : "none" }}
					>
						<CodeEditor
							tabId={t.id}
							isActive={t.id === activeFileTabId}
							content={t.content ?? ""}
							language={t.language}
							initialEditorState={t.initialEditorState}
							onChange={(content) => updateFileContent(t.id, content)}
						/>
					</div>
				))}
			{/* Non-text viewers only render when active (no state to preserve) */}
			{activeTab.fileType === "image" && (
				<ImageViewer
					content={activeTab.content ?? ""}
					mime={activeTab.mime ?? "image/png"}
					fileName={activeTab.fileName}
				/>
			)}
			{activeTab.fileType === "binary" && (
				<UnsupportedFile fileName={activeTab.fileName} size={0} />
			)}
		</>
	);
}
