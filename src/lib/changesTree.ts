/**
 * **Tree view** of the Git changes tab: one **Section**'s changed files laid
 * out under **Folder rows**. See the `Tree view` and `Folder row` entries in
 * GLOSSARY.md.
 *
 * Pure: the component turns the visible rows into DOM and owns nothing else.
 */

import type { GitChangedFile } from "./types";

export interface FolderNode {
	kind: "folder";
	/** Repo-relative path of the deepest folder this row stands for. */
	path: string;
	/** What the row shows: one folder name, or a merged chain of them
	 *  (`components/GitChanges`). */
	name: string;
	children: TreeNode[];
}

export interface FileNode {
	kind: "file";
	file: GitChangedFile;
}

export type TreeNode = FolderNode | FileNode;

/** One row to draw, with how deep it sits. */
export type TreeRow =
	| { kind: "folder"; node: FolderNode; depth: number; collapsed: boolean }
	| { kind: "file"; file: GitChangedFile; depth: number };

/** The key a folded Folder row is remembered under. */
export function folderKey(section: string, folderPath: string): string {
	return `${section}\u0000${folderPath}`;
}

interface MutableFolder {
	path: string;
	folders: Map<string, MutableFolder>;
	files: GitChangedFile[];
}

const byName = (a: string, b: string) => a.localeCompare(b);

/**
 * Builds the tree for one Section's files: folders before files, each
 * alphabetical, and a chain of folders that each hold only one folder merged
 * into a single row. Root-level files sit at the top level.
 */
export function buildChangesTree(files: GitChangedFile[]): TreeNode[] {
	const root: MutableFolder = { path: "", folders: new Map(), files: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		let folder = root;
		for (const part of parts.slice(0, -1)) {
			let next = folder.folders.get(part);
			if (!next) {
				next = {
					path: folder.path ? `${folder.path}/${part}` : part,
					folders: new Map(),
					files: [],
				};
				folder.folders.set(part, next);
			}
			folder = next;
		}
		folder.files.push(file);
	}
	return childrenOf(root);
}

function childrenOf(folder: MutableFolder): TreeNode[] {
	const folders = [...folder.folders.entries()]
		.sort(([a], [b]) => byName(a, b))
		.map(([name, child]) => toFolderNode(name, child));
	const files = [...folder.files]
		.sort((a, b) => byName(a.path, b.path))
		.map((file): FileNode => ({ kind: "file", file }));
	return [...folders, ...files];
}

function toFolderNode(name: string, folder: MutableFolder): FolderNode {
	let label = name;
	let current = folder;
	// Merge a chain of folders that hold nothing but one folder each.
	while (current.files.length === 0 && current.folders.size === 1) {
		const [[childName, child]] = [...current.folders.entries()];
		label = `${label}/${childName}`;
		current = child;
	}
	return {
		kind: "folder",
		path: current.path,
		name: label,
		children: childrenOf(current),
	};
}

/** The rows to draw, in order, skipping the contents of folded folders. */
export function visibleTreeRows(
	nodes: TreeNode[],
	isCollapsed: (folderPath: string) => boolean,
	depth = 0,
): TreeRow[] {
	const rows: TreeRow[] = [];
	for (const node of nodes) {
		if (node.kind === "file") {
			rows.push({ kind: "file", file: node.file, depth });
			continue;
		}
		const collapsed = isCollapsed(node.path);
		rows.push({ kind: "folder", node, depth, collapsed });
		if (!collapsed) {
			rows.push(...visibleTreeRows(node.children, isCollapsed, depth + 1));
		}
	}
	return rows;
}
