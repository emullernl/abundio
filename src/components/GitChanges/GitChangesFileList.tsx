import {
	buildChangesTree,
	compareByFolderThenName,
	folderKey,
	type TreeRow,
	visibleTreeRows,
} from "../../lib/changesTree";
import type { GitChangedFile } from "../../lib/types";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ChevronDown, ChevronRight } from "../Icons";
import { GitChangesFileItem } from "./GitChangesFileItem";
import { GitChangesFolderRow } from "./GitChangesFolderRow";

/** A **Folder row** the **Folder menu** is about: which Section, which
 *  folder. */
export interface FolderTarget {
	section: string;
	/** Repo-relative path of the deepest folder the row stands for. */
	path: string;
}

interface Props {
	files: GitChangedFile[];
	baseBranch: string | null;
	onSelectFile: (file: GitChangedFile) => void;
	onOpenFile: (file: GitChangedFile) => void;
	onContextMenu: (
		x: number,
		y: number,
		file: GitChangedFile,
		fromKeyboard: boolean,
	) => void;
	selectedFile: GitChangedFile | null;
	/** The row the **Row menu** is open on, if any. */
	menuTargetFile: GitChangedFile | null;
	onFolderContextMenu: (
		x: number,
		y: number,
		folder: FolderTarget,
		fromKeyboard: boolean,
	) => void;
	/** The Folder row the **Folder menu** is open on, if any. */
	menuTargetFolder: FolderTarget | null;
}

const SECTION_ORDER: Array<{
	key: string;
	label: (base: string | null) => string;
}> = [
	// Conflicted leads: it is blocking, and a stable first section keeps the
	// backend's array order — which `filesEqual` depends on — easy to reason
	// about. Note this section is a *state*, not an endpoint pair like the rest.
	{ key: "conflicted", label: () => "Conflicted" },
	{ key: "against_base", label: (base) => `Against ${base ?? "base"}` },
	{ key: "staged", label: () => "Staged" },
	{ key: "unstaged", label: () => "Unstaged" },
	{ key: "untracked", label: () => "Untracked" },
];

export function GitChangesFileList({
	files,
	baseBranch,
	onSelectFile,
	onOpenFile,
	onContextMenu,
	selectedFile,
	menuTargetFile,
	onFolderContextMenu,
	menuTargetFolder,
}: Props) {
	const collapsedSections = useGitChangesStore((s) => s.collapsedSections);
	const toggleSection = useGitChangesStore((s) => s.toggleSection);
	const collapsedFolders = useGitChangesStore((s) => s.collapsedFolders);
	const toggleFolder = useGitChangesStore((s) => s.toggleFolder);
	const treeView = useSettingsStore((s) => s.gitChangesTreeView);

	function rowsOf(section: string, files: GitChangedFile[]): TreeRow[] {
		if (!treeView) {
			return files.map((file) => ({ kind: "file", file, depth: 0 }));
		}
		return visibleTreeRows(
			buildChangesTree(files),
			(path) => collapsedFolders[folderKey(section, path)] ?? false,
		);
	}

	const grouped = SECTION_ORDER.map(({ key, label }) => ({
		key,
		label: label(baseBranch),
		files: files
			.filter((f) => f.section === key)
			.sort((a, b) => compareByFolderThenName(a.path, b.path)),
	})).filter((g) => g.files.length > 0);

	if (grouped.length === 0) {
		return (
			<div
				className="flex items-center justify-center h-32"
				style={{ color: "var(--fg-secondary)", fontSize: 13 }}
			>
				No changes detected
			</div>
		);
	}

	return (
		<div className="flex flex-col">
			{grouped.map((group) => {
				const isCollapsed = collapsedSections[group.key] ?? false;
				const totalAdditions = group.files.reduce((s, f) => s + f.additions, 0);
				const totalDeletions = group.files.reduce((s, f) => s + f.deletions, 0);

				return (
					<div key={group.key}>
						<button
							type="button"
							onClick={() => toggleSection(group.key)}
							className="w-full flex items-center gap-1.5 py-1.5 transition-colors"
							style={{
								backgroundColor:
									"color-mix(in srgb, var(--bg-tertiary) 40%, transparent)",
								borderBottom: "1px solid var(--border)",
								paddingLeft: 12,
								paddingRight: 12,
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor =
									"color-mix(in srgb, var(--bg-tertiary) 40%, transparent)";
							}}
						>
							{isCollapsed ? (
								<ChevronRight
									size={12}
									style={{ color: "var(--fg-secondary)" }}
								/>
							) : (
								<ChevronDown
									size={12}
									style={{ color: "var(--fg-secondary)" }}
								/>
							)}
							<span
								className="flex-1 text-left font-medium truncate"
								style={{
									fontSize: 11,
									color: "var(--fg-secondary)",
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								{group.label}
							</span>
							<span
								className="flex-shrink-0 inline-flex items-center justify-center rounded-full"
								style={{
									fontSize: 10,
									color: "var(--fg-secondary)",
									backgroundColor: "var(--bg-tertiary)",
									minWidth: 18,
									height: 18,
									padding: "0 5px",
									fontFamily: "var(--font-ui)",
								}}
							>
								{group.files.length}
							</span>
							{(totalAdditions > 0 || totalDeletions > 0) && (
								<span
									className="flex-shrink-0 flex items-center gap-1"
									style={{ fontSize: 10, fontFamily: "var(--font-ui)" }}
								>
									{totalAdditions > 0 && (
										<span style={{ color: "var(--success)" }}>
											+{totalAdditions}
										</span>
									)}
									{totalDeletions > 0 && (
										<span style={{ color: "var(--error)" }}>
											-{totalDeletions}
										</span>
									)}
								</span>
							)}
						</button>
						{!isCollapsed && (
							<div>
								{rowsOf(group.key, group.files).map((row) => {
									if (row.kind === "folder") {
										const { node } = row;
										return (
											<GitChangesFolderRow
												key={`${group.key}-dir-${node.path}`}
												node={node}
												depth={row.depth}
												collapsed={row.collapsed}
												isMenuTarget={
													menuTargetFolder?.section === group.key &&
													menuTargetFolder?.path === node.path
												}
												onToggle={() => toggleFolder(group.key, node.path)}
												onContextMenu={(x, y, fromKeyboard) =>
													onFolderContextMenu(
														x,
														y,
														{ section: group.key, path: node.path },
														fromKeyboard,
													)
												}
											/>
										);
									}
									const { file } = row;
									return (
										<GitChangesFileItem
											key={`${group.key}-${file.path}`}
											file={file}
											depth={row.depth}
											showDir={!treeView}
											isSelected={
												selectedFile?.path === file.path &&
												selectedFile?.section === file.section
											}
											isMenuTarget={
												menuTargetFile?.path === file.path &&
												menuTargetFile?.section === file.section
											}
											onClick={() => onSelectFile(file)}
											onOpenFile={() => onOpenFile(file)}
											onContextMenu={(x, y, fromKeyboard) =>
												onContextMenu(x, y, file, fromKeyboard)
											}
										/>
									);
								})}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
