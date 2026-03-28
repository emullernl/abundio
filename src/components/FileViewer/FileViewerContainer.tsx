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

	switch (activeTab.fileType) {
		case "text":
			return (
				<CodeEditor
					key={activeTab.id}
					content={activeTab.content ?? ""}
					language={activeTab.language}
					onChange={(content) => updateFileContent(activeTab.id, content)}
				/>
			);
		case "image":
			return (
				<ImageViewer
					content={activeTab.content ?? ""}
					mime={activeTab.mime ?? "image/png"}
					fileName={activeTab.fileName}
				/>
			);
		case "binary":
			return <UnsupportedFile fileName={activeTab.fileName} size={0} />;
		default:
			return null;
	}
}
