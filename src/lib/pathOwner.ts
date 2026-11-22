/**
 * The Workspace a path belongs to, for routing a call by path to the
 * backend that holds it. Pure.
 *
 * This Window's own Workspaces always win: a joined Workspace's folder is
 * whatever its Host says, so a Host claiming a folder inside (or around) one
 * of this computer's would otherwise receive this computer's file reads and
 * saves there (ADR-0065: a Host never reaches this computer). A joined
 * Workspace is the owner only of a path no own Workspace holds, and one
 * whose folder is the filesystem's root holds none.
 */
export function workspaceForPath(
	workspaces: readonly { id: string; rootFolder: string; joined?: unknown }[],
	path: string,
): string | undefined {
	const deepest = (joined: boolean) => {
		let best: { id: string; len: number } | undefined;
		for (const ws of workspaces) {
			if (!!ws.joined !== joined) continue;
			const root = ws.rootFolder.replace(/[\\/]+$/, "");
			if (joined && root === "") continue;
			const inside =
				path === root ||
				path.startsWith(`${root}/`) ||
				path.startsWith(`${root}\\`);
			if (inside && (!best || root.length > best.len)) {
				best = { id: ws.id, len: root.length };
			}
		}
		return best?.id;
	};
	return deepest(false) ?? deepest(true);
}
