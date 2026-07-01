import { homeDir } from "@tauri-apps/api/path";
import type { IDisposable, ILink, Terminal } from "@xterm/xterm";
import { useExplorerStore } from "../stores/explorerStore";
import { usePtyActivityStore } from "../stores/ptyActivityStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { containsPane, parseTabLayout } from "./paneTree";
import { isWorkspaceFile } from "./workspaceFileIndex";

// Resolved once at module load. `~/` expansion is best-effort; if this rejects
// (e.g. inside a Vitest run where Tauri isn't wired up) `~/`-prefixed paths
// just don't link, which is the correct degradation.
let cachedHome: string | undefined;
homeDir()
	.then((h) => {
		cachedHome = h.replace(/\/$/, "");
	})
	.catch(() => {
		/* ignore — paths starting with ~/ won't resolve */
	});

/**
 * Terminal file links — see ADR-0004.
 *
 * Registers an xterm `ILinkProvider` that scans the visible line for
 * path-shaped substrings (absolute, or relative to the PTY's live CWD),
 * resolves them against the workspace file index, and turns each hit into a
 * hover-underlined, Cmd/Ctrl+click-activatable link. Activation routes
 * through `useExplorerStore.openFile` so the file lands in an existing file
 * pane if open in any Tab, or in a new Tab otherwise; trailing `:line[:col]`
 * or `(line,col)` annotations populate `pendingGotoLine` so the editor
 * jumps. Plain click is intentionally NOT handled — that's selection /
 * focus / mouse-reporting territory.
 */

// Path-ish match. Anchored on a sane left boundary (start of line, or a
// character that wouldn't otherwise belong to a path) to avoid biting into
// surrounding identifiers. Body allows the usual path characters. Tail
// captures optional :line[:col] or (line,col) for jump-to-line.
//
// The pattern is intentionally permissive — it'll happily match arbitrary
// alphanumeric runs like `emilmuller@MacBookPro` or `64`. Precision comes
// from the workspace-file-index lookup downstream: a candidate only becomes
// a link if it resolves to a real file in the workspace. The looser regex
// is what makes `ls` / `git status` / agent output light up, since most of
// those formats print bare basenames (`Cargo.toml`, `README.md`, `src`)
// rather than slash-separated paths.
// Use `String.matchAll` rather than `RegExp.exec` in a loop so that each call
// gets its own internal iterator — no shared `lastIndex` to reset or corrupt
// if `findPathMatches` ever ends up re-entrantly called (e.g. a future
// callback that hovers from inside the loop body). V8 caches the compiled
// pattern, so per-call construction would be cheap, but `matchAll` is even
// cleaner since the regex literal can stay module-level.
const PATH_PATTERN =
	/(?:(?<=^)|(?<=[\s"'`([<>,]))([\w.+\-@/~]+)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

type Match = {
	rawText: string;
	pathOnly: string;
	line: number | null;
	col: number | null;
	startIndex: number;
	endIndex: number;
};

export function findPathMatches(lineText: string): Match[] {
	const out: Match[] = [];
	for (const m of lineText.matchAll(PATH_PATTERN)) {
		const pathOnly = m[1];
		const line = m[2] ?? m[4];
		const col = m[3] ?? m[5];
		out.push({
			rawText: m[0],
			pathOnly,
			line: line ? Number(line) : null,
			col: col ? Number(col) : null,
			// m.index points at the start of the whole match. The first capture
			// group is anchored at the start of the match, so its offset equals
			// the match index.
			startIndex: m.index,
			endIndex: m.index + m[0].length,
		});
	}
	return out;
}

/**
 * Resolve a path string to an absolute, normalized path. Relative paths
 * (including `./`, `../`, and bare `src/foo.ts`) are resolved against `cwd`.
 * Absolute paths and `~/` paths are normalized but otherwise passed through.
 * `~/` is expanded only if `home` is provided.
 *
 * Pure string manipulation — no fs. Mirrors POSIX semantics; the app is
 * macOS/Linux-first and Windows users live with forward-slash paths in their
 * terminal output via WSL/Git Bash.
 */
export function resolveAbsolute(
	pathStr: string,
	cwd: string | undefined,
	home?: string,
): string | null {
	if (!pathStr) return null;
	let raw = pathStr;
	if (raw.startsWith("~/")) {
		if (!home) return null;
		raw = home + raw.slice(1);
	}
	let base: string;
	if (raw.startsWith("/")) {
		base = raw;
	} else {
		if (!cwd) return null;
		base = `${cwd}/${raw}`;
	}
	const parts = base.split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			out.pop();
			continue;
		}
		out.push(part);
	}
	return `/${out.join("/")}`;
}

function findWorkspaceIdForPane(paneId: string): string | null {
	const { workspaces } = useWorkspaceStore.getState();
	for (const w of workspaces) {
		for (const tab of w.tabs) {
			const layout = parseTabLayout(tab.layoutJson);
			if (layout && containsPane(layout, paneId)) return w.id;
		}
	}
	return null;
}

/**
 * Install the file-link provider on the given terminal. Returns the xterm
 * disposable; xterm also disposes link providers when the terminal itself is
 * disposed, so callers may safely ignore the return value if they only need
 * the provider for the terminal's lifetime.
 */
export function installFileLinkProvider(
	term: Terminal,
	paneId: string,
): IDisposable {
	// Cache the pane→workspace lookup. Panes don't migrate between workspaces,
	// so the first successful answer is good for the lifetime of the provider.
	let cachedWorkspaceId: string | null = null;
	const getWorkspaceId = (): string | null => {
		if (cachedWorkspaceId) return cachedWorkspaceId;
		cachedWorkspaceId = findWorkspaceIdForPane(paneId);
		return cachedWorkspaceId;
	};

	const getCwd = (): string | undefined => {
		// The pane→PTY mapping lives in ptyActivityStore. We read CWD off the
		// live entry; if there's no entry the path simply won't resolve.
		const actStore = usePtyActivityStore.getState();
		const ptyId = actStore.panePtyMap[paneId];
		if (!ptyId) return undefined;
		return actStore.cwds[ptyId] || undefined;
	};

	return term.registerLinkProvider({
		provideLinks(bufferLineNumber, callback) {
			const workspaceId = getWorkspaceId();
			if (!workspaceId) {
				callback(undefined);
				return;
			}
			const buf = term.buffer.active;
			// xterm passes `bufferLineNumber` as a 1-based index into the
			// viewport's full buffer; getLine takes 0-based.
			const bufLine = buf.getLine(bufferLineNumber - 1);
			if (!bufLine) {
				callback(undefined);
				return;
			}
			const text = bufLine.translateToString(true);
			if (!text) {
				callback(undefined);
				return;
			}

			const cwd = getCwd();
			const matches = findPathMatches(text);
			const links: ILink[] = [];
			for (const m of matches) {
				const abs = resolveAbsolute(m.pathOnly, cwd, cachedHome);
				if (!abs) continue;
				if (!isWorkspaceFile(workspaceId, abs)) continue;
				links.push({
					// xterm IBufferRange uses 1-based columns. text indices are
					// 0-based; +1 to enter xterm space, end is inclusive so we
					// keep `endIndex` unchanged (which is start + length, i.e.
					// one past the last char in 0-based → end in 1-based
					// inclusive).
					range: {
						start: { x: m.startIndex + 1, y: bufferLineNumber },
						end: { x: m.endIndex, y: bufferLineNumber },
					},
					text: m.rawText,
					activate: () => {
						const explorer = useExplorerStore.getState();
						if (m.line != null) {
							explorer.setPendingGotoLine({
								filePath: abs,
								line: m.line,
							});
						}
						explorer.openFile(workspaceId, abs).catch((err) => {
							console.error("[terminalFileLinks] openFile failed:", err);
						});
					},
				});
			}
			callback(links.length > 0 ? links : undefined);
		},
	});
}
