import { useWorkspaceStore } from "../../stores/workspaceStore";
import { FileTree } from "./FileTree";

export function Explorer() {
	const activeWorkspace = useWorkspaceStore((s) =>
		s.workspaces.find((sess) => sess.id === s.activeWorkspaceId),
	);

	if (!activeWorkspace) return null;

	return (
		<div className="flex flex-col min-h-0 h-full">
			<div className="flex-1 overflow-y-auto min-h-0">
				<FileTree
					rootPath={activeWorkspace.rootFolder}
					workspaceId={activeWorkspace.id}
				/>
			</div>
		</div>
	);
}
