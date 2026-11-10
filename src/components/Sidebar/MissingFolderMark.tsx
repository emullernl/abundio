import { FolderX } from "../Icons";

/** The hover text for a **Missing folder** (ADR-0053). */
export function missingFolderTitle(rootFolder: string): string {
	return `Folder not found: ${rootFolder}`;
}

/** The amber mark after a Missing-folder Workspace's name. */
export function MissingFolderMark({
	rootFolder,
	size = 12,
}: {
	rootFolder: string;
	size?: number;
}) {
	return (
		<span
			data-missing-folder
			role="img"
			aria-label={missingFolderTitle(rootFolder)}
			title={missingFolderTitle(rootFolder)}
			className="inline-flex flex-shrink-0"
			style={{ color: "var(--warning)" }}
		>
			<FolderX size={size} strokeWidth={2.25} />
		</span>
	);
}

/** The collapsed sidebar's version: a small amber dot on the Workspace's
 *  icon, cut out of the strip's background like the Dirty ring. */
export function MissingFolderDot({ rootFolder }: { rootFolder: string }) {
	return (
		<span
			data-missing-folder
			role="img"
			aria-label={missingFolderTitle(rootFolder)}
			title={missingFolderTitle(rootFolder)}
			style={{
				position: "absolute",
				left: -3,
				top: -2,
				width: 7,
				height: 7,
				borderRadius: "50%",
				backgroundColor: "var(--warning)",
				boxShadow: "0 0 0 1.5px var(--bg-secondary)",
			}}
		/>
	);
}
