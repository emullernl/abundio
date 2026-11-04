import { open } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeEditor } from "./components/FileViewer/CodeEditor";
import { FileChangeBanner } from "./components/FileViewer/FileChangeBanner";
import { ImageViewer } from "./components/FileViewer/ImageViewer";
import { MarkdownRendered } from "./components/FileViewer/MarkdownRendered";
import { FileWindowToolbar } from "./components/FileWindow/FileWindowToolbar";
import { MarkdownFindBar } from "./components/FileWindow/MarkdownFindBar";
import "./components/FileWindow/FileWindow.css";
import { DiffViewer } from "./components/GitChanges/DiffViewer";
import { SaveConfirmDialog } from "./components/SaveConfirmDialog";
import { useShortcutLabel } from "./hooks/useShortcutLabel";
import { appWindow } from "./lib/appWindow";
import {
	diskChanged,
	diskRemoved,
	edited,
	type FileBuffer,
	isDirty,
	keptEdits,
	loadedBuffer,
	reloaded,
	savedBuffer,
} from "./lib/fileWindowBuffer";
import {
	type FileWindowInfo,
	fileWindows,
	fs as fsApi,
	git as gitApi,
	type MarkdownView,
} from "./lib/ipc";
import { isMarkdownFile } from "./lib/isMarkdownFile";
import {
	initKeybindings,
	registerAction,
	setKeybindingOverrides,
	unregisterAction,
} from "./lib/keybindings";
import { classifyMarkdownLink, scrollToFragment } from "./lib/markdownLinks";
import { printMarkdownPreview } from "./lib/markdownPrint";
import { applyMonacoOverrides } from "./lib/monacoKeymap";
import { detectLanguage } from "./lib/monacoShared";
import { openFileWindowForPath } from "./lib/openFileWindow";
import { resolvePreviewColorMode } from "./lib/previewColorMode";
import { resolveWorkspacePath } from "./lib/resolveWorkspacePath";
import { getTheme } from "./lib/themes";
import type { GitFileDiff } from "./lib/types";
import { requestSettingsSnapshot } from "./SettingsApp";
import type { FilePaneState } from "./stores/explorerStore";
import { useSettingsStore } from "./stores/settingsStore";

// Base editor font size — the rendered zoom follows Cmd+= / Cmd+- like the
// Preview pane does.
const BASE_FONT_SIZE = 14;
// CodeEditor caches view state by this id. One editor per window.
const EDITOR_ID = "file-window";

// Either separator: Windows paths come back with backslashes.
const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || path;
const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/**
 * Root of a **File window** (label `md-<uuid>`, a prefix kept from when these
 * were Markdown windows): one thing of a Workspace that a File pane could
 * show. See ADR-0046 and ADR-0049. Which thing comes from Rust by label
 * (`file_window_info`), never from the URL.
 */
export function FileWindowApp() {
	const [info, setInfo] = useState<FileWindowInfo | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		requestSettingsSnapshot();
		const load = () =>
			fileWindows
				.info()
				.then(setInfo)
				.catch((e) => setLoadError(String(e)));
		load();
		// A live diff opened again from another section: same window, new row.
		const unlisten = fileWindows.onReloadRequested(load);
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, []);

	if (loadError) return <LoadError message={loadError} />;
	if (!info) return <Shell />;
	switch (info.kind) {
		case "image":
			return <ImageWindow info={info} />;
		case "diff":
		case "commit-diff":
			return <DiffWindow info={info} />;
		default:
			return <TextWindow info={info} />;
	}
}

/**
 * A text File window: one file, editable. A markdown file is shown rendered
 * (read-only) or as Monaco source; any other text file only as source.
 *
 * It keeps its own buffer. A File pane on the same file in a Profile window
 * is a separate buffer; each sees the other's save as an external change,
 * through the file watcher.
 *
 * Closing: the window's own close (red button, Cmd+W) asks about unsaved
 * edits and then *forgets* the window. Every close driven by its owner
 * (Workspace close, Profile switch, owning Window closed, quit) destroys the
 * window from Rust, which skips this handler, so the row stays and the
 * window reopens with its Workspace.
 */
function TextWindow({ info }: { info: FileWindowInfo }) {
	const [loadError, setLoadError] = useState<string | null>(null);
	const [buffer, setBuffer] = useState<FileBuffer | null>(null);
	const isMarkdown = isMarkdownFile(info.filePath);
	const [storedView, setView] = useState<MarkdownView>(info.view);
	// Only markdown has a rendered view.
	const view: MarkdownView = isMarkdown ? storedView : "source";
	const [findOpen, setFindOpen] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
	// Why the last save failed, shown until the next save works or the user
	// dismisses it. Every save path lands here: Cmd+S, Save on close, and the
	// owner's Save before it closes the Workspace.
	const [saveError, setSaveError] = useState<string | null>(null);
	const contentRef = useRef<HTMLDivElement>(null);

	const bufferRef = useRef(buffer);
	bufferRef.current = buffer;
	const infoRef = useRef(info);
	infoRef.current = info;

	const fontSize = useSettingsStore((s) => s.fontSize);
	const colorMode = useSettingsStore((s) => s.markdownPreviewColorMode);
	const toggleColorMode = useSettingsStore(
		(s) => s.toggleMarkdownPreviewColorMode,
	);
	const themeVariant = useSettingsStore((s) => getTheme(s.theme).variant);
	const resolvedMode = resolvePreviewColorMode(colorMode, themeVariant);
	const followTheme = colorMode === "auto";
	const findLabel = useShortcutLabel("search-in-terminal");
	const toggleLabel = useShortcutLabel("toggle-markdown-preview");

	const dirty = buffer ? isDirty(buffer) : false;

	// ── Load ──
	useEffect(() => {
		(async () => {
			try {
				const file = await fsApi.readFile(info.filePath);
				if (file.fileType !== "text") {
					setLoadError("It is not a text file.");
					return;
				}
				setBuffer(loadedBuffer(file.content ?? ""));
			} catch (e) {
				setLoadError(String(e));
			}
		})();
	}, [info.filePath]);

	// The owning Window asks Rust, not us, whether we have unsaved edits.
	useEffect(() => {
		fileWindows.setDirty(dirty).catch(() => {});
	}, [dirty]);

	const save = useCallback(async () => {
		const b = bufferRef.current;
		const i = infoRef.current;
		if (!b || !i) return;
		try {
			await fsApi.writeFile(i.filePath, b.content);
		} catch (e) {
			setSaveError(String(e));
			throw e;
		}
		setSaveError(null);
		// Edits typed while the write was in flight stay dirty.
		setBuffer((cur) =>
			cur ? { ...savedBuffer(b), content: cur.content } : cur,
		);
	}, []);

	// The owner's "Save" before it closes a Workspace.
	useEffect(() => {
		const unlisten = fileWindows.onSaveRequested(() => {
			save().catch((e) => console.error("[file-window] save failed:", e));
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, [save]);

	// ── External changes ──
	useEffect(() => {
		if (!info) return;
		const root = info.rootFolder;
		const path = info.filePath;
		fsApi.watchStart(root).catch(() => {});
		const unlisten = fsApi.onFsChange(root, (change) => {
			if (change.removedFiles.includes(path)) {
				setBuffer((b) => (b ? diskRemoved(b) : b));
				return;
			}
			if (!change.changedFiles.includes(path)) return;
			fsApi
				.readFile(path)
				.then((file) => {
					if (file.fileType !== "text") return;
					setBuffer((b) => (b ? diskChanged(b, file.content ?? "") : b));
				})
				.catch(() => {});
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
			fsApi.watchStop(root).catch(() => {});
		};
	}, [info]);

	// ── Closing ──
	const finishClose = useCallback(async () => {
		await fileWindows.forget().catch(() => {});
		await appWindow()
			?.destroy()
			.catch(() => {});
	}, []);

	const requestClose = useCallback(() => {
		const b = bufferRef.current;
		if (b && isDirty(b)) setConfirmClose(true);
		else void finishClose();
	}, [finishClose]);

	useEffect(() => {
		const win = appWindow();
		if (!win) return;
		const unlisten = win.onCloseRequested((event) => {
			event.preventDefault();
			requestClose();
		});
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, [requestClose]);

	// ── View ──
	const changeView = useCallback((next: MarkdownView) => {
		setView(next);
		if (next === "source") setFindOpen(false);
		fileWindows.setView(next).catch(() => {});
	}, []);
	const viewRef = useRef(view);
	viewRef.current = view;

	const doPrint = useCallback(() => {
		if (contentRef.current) printMarkdownPreview(contentRef.current);
	}, []);

	// ── Keys ──
	useEffect(() => {
		const apply = () => {
			const overrides = useSettingsStore.getState().keybindingOverrides;
			setKeybindingOverrides(overrides);
			applyMonacoOverrides(overrides);
		};
		apply();
		const unsubscribe = useSettingsStore.subscribe((s, prev) => {
			if (s.keybindingOverrides !== prev.keybindingOverrides) apply();
		});
		const stopKeys = initKeybindings();
		const stepFont = (by: number) => {
			const { fontSize: size, setFontSize } = useSettingsStore.getState();
			setFontSize(Math.min(Math.max(size + by, 8), 32));
		};
		registerAction("save-file", () => {
			save().catch((e) => console.error("[file-window] save failed:", e));
		});
		// The "Toggle markdown preview" chord swaps the view here.
		registerAction("toggle-markdown-preview", () => {
			if (isMarkdown) {
				changeView(viewRef.current === "rendered" ? "source" : "rendered");
			}
		});
		// Monaco handles its own Find while it has focus; this covers the
		// rendered view.
		registerAction("search-in-terminal", () => {
			if (viewRef.current === "rendered") setFindOpen(true);
		});
		registerAction("font-size-increase", () => stepFont(1));
		registerAction("font-size-decrease", () => stepFont(-1));
		registerAction("close-tab", requestClose);
		return () => {
			unsubscribe();
			stopKeys();
			for (const a of [
				"save-file",
				"toggle-markdown-preview",
				"search-in-terminal",
				"font-size-increase",
				"font-size-decrease",
				"close-tab",
			] as const) {
				unregisterAction(a);
			}
		};
	}, [save, changeView, requestClose, isMarkdown]);

	// ── Links ──
	const onLinkClick = useCallback((href: string | undefined) => {
		const i = infoRef.current;
		if (!i) return;
		const action = classifyMarkdownLink(href, dirOf(i.filePath), i.rootFolder);
		switch (action.kind) {
			case "fragment":
				if (contentRef.current) scrollToFragment(contentRef.current, action.id);
				return;
			case "external":
				open(action.url).catch(() => {});
				return;
			case "workspace-markdown":
				fileWindows
					.open(i.workspaceId, { kind: "text", filePath: action.path })
					.catch((e) => {
						console.error("[file-window] open link failed:", e);
					});
				return;
			default:
				return;
		}
	}, []);

	if (loadError) return <LoadError message={loadError} />;
	if (!buffer) return <Shell />;

	// FileChangeBanner reads only the change flags off a File pane's state.
	const bannerState = {
		isDirty: dirty,
		externallyChanged: buffer.externallyChanged,
		deletedOnDisk: buffer.deletedOnDisk,
	} as FilePaneState;

	return (
		<Shell>
			<FileWindowToolbar
				fileName={fileNameOf(info.filePath)}
				workspaceName={info.workspaceName}
				dirty={dirty}
				markdown={isMarkdown}
				view={view}
				onViewChange={changeView}
				colorMode={colorMode}
				onToggleColorMode={toggleColorMode}
				onFind={() => setFindOpen(true)}
				onPrint={doPrint}
				findLabel={findLabel ? `Find (${findLabel})` : "Find"}
				toggleLabel={
					toggleLabel ? `Switch view (${toggleLabel})` : "Switch view"
				}
			/>
			{saveError && (
				<div
					role="alert"
					className="flex items-center gap-3 shrink-0"
					style={{
						padding: "8px 12px 8px 16px",
						fontSize: 12,
						borderBottom: "1px solid var(--border)",
						backgroundColor:
							"color-mix(in srgb, var(--error) 14%, var(--bg-secondary))",
						color: "var(--fg-primary)",
					}}
				>
					<span className="flex-1 min-w-0">
						Could not save {fileNameOf(info.filePath)}. Your edits are still
						here. {saveError}
					</span>
					<button
						type="button"
						onClick={() => void save().catch(() => {})}
						className="shrink-0 rounded-md cursor-pointer border border-[var(--border)] text-[var(--fg-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--fg-primary)]"
						style={{ padding: "3px 10px", fontSize: 12 }}
					>
						Try again
					</button>
					<button
						type="button"
						onClick={() => setSaveError(null)}
						className="shrink-0 rounded-md cursor-pointer border-0 bg-transparent text-[var(--fg-secondary)] hover:text-[var(--fg-primary)]"
						style={{ padding: "3px 6px", fontSize: 12 }}
					>
						Dismiss
					</button>
				</div>
			)}
			<FileChangeBanner
				paneId={EDITOR_ID}
				paneState={bannerState}
				onReload={() => setBuffer((b) => (b ? reloaded(b) : b))}
				onKeepEdits={() => setBuffer((b) => (b ? keptEdits(b) : b))}
				onSave={() => void save()}
				onClose={() => void finishClose()}
			/>
			<div className="relative flex-1 min-h-0 flex flex-col">
				{view === "rendered" ? (
					<>
						{findOpen && (
							<MarkdownFindBar
								target={contentRef.current}
								contentKey={buffer.content}
								onClose={() => setFindOpen(false)}
							/>
						)}
						<div
							ref={contentRef}
							tabIndex={-1}
							className="flex-1 min-h-0 overflow-auto abundio-md-preview outline-none"
							data-color-mode={resolvedMode}
							data-themed={followTheme ? "true" : undefined}
							style={{
								padding: "32px 44px",
								background: followTheme ? "var(--bg-primary)" : "#ffffff",
							}}
						>
							<div style={{ maxWidth: 860, margin: "0 auto" }}>
								<MarkdownRendered
									content={buffer.content}
									baseDir={dirOf(info.filePath)}
									resolvedMode={resolvedMode}
									zoom={fontSize / BASE_FONT_SIZE}
									onLinkClick={onLinkClick}
								/>
							</div>
						</div>
					</>
				) : (
					<CodeEditor
						tabId={EDITOR_ID}
						isActive
						content={buffer.content}
						language={
							isMarkdown
								? "markdown"
								: (detectLanguage(info.filePath) ?? "plaintext")
						}
						initialEditorState={null}
						onChange={(content) =>
							setBuffer((b) => (b ? edited(b, content) : b))
						}
						forceWordWrap={isMarkdown}
					/>
				)}
			</div>
			{confirmClose && (
				<SaveConfirmDialog
					fileName={fileNameOf(info.filePath)}
					onSave={async () => {
						setConfirmClose(false);
						try {
							await save();
							await finishClose();
						} catch (e) {
							console.error("[file-window] save failed:", e);
						}
					}}
					onDontSave={() => {
						setConfirmClose(false);
						void finishClose();
					}}
					onCancel={() => setConfirmClose(false)}
				/>
			)}
		</Shell>
	);
}

/**
 * Closing and keys for a read-only File window (an image or a diff). Nothing
 * can be unsaved, so its own close just forgets it. The owner's closes
 * destroy it from Rust and skip this, so its row is kept (ADR-0046).
 */
function useReadOnlyWindowChrome(): void {
	useEffect(() => {
		const close = () => {
			void (async () => {
				await fileWindows.forget().catch(() => {});
				await appWindow()
					?.destroy()
					.catch(() => {});
			})();
		};
		const win = appWindow();
		const unlistenClose = win?.onCloseRequested((event) => {
			event.preventDefault();
			close();
		});

		const apply = () => {
			const overrides = useSettingsStore.getState().keybindingOverrides;
			setKeybindingOverrides(overrides);
			applyMonacoOverrides(overrides);
		};
		apply();
		const unsubscribe = useSettingsStore.subscribe((s, prev) => {
			if (s.keybindingOverrides !== prev.keybindingOverrides) apply();
		});
		const stopKeys = initKeybindings();
		const stepFont = (by: number) => {
			const { fontSize: size, setFontSize } = useSettingsStore.getState();
			setFontSize(Math.min(Math.max(size + by, 8), 32));
		};
		registerAction("font-size-increase", () => stepFont(1));
		registerAction("font-size-decrease", () => stepFont(-1));
		registerAction("close-tab", close);
		return () => {
			unlistenClose?.then((fn) => fn()).catch(() => {});
			unsubscribe();
			stopKeys();
			for (const a of [
				"font-size-increase",
				"font-size-decrease",
				"close-tab",
			] as const) {
				unregisterAction(a);
			}
		};
	}, []);
}

/** Runs `onChange` (at most every 300ms) whenever something changes under
 *  the Workspace folder, while the window holds a watch on it. */
function useFolderChanges(
	root: string,
	enabled: boolean,
	onChange: (change: {
		changedFiles: string[];
		removedFiles: string[];
	}) => void,
): void {
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let pending = {
			changedFiles: [] as string[],
			removedFiles: [] as string[],
		};
		fsApi.watchStart(root).catch(() => {});
		const unlisten = fsApi.onFsChange(root, (change) => {
			pending = {
				changedFiles: [...pending.changedFiles, ...change.changedFiles],
				removedFiles: [...pending.removedFiles, ...change.removedFiles],
			};
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				const batch = pending;
				pending = { changedFiles: [], removedFiles: [] };
				onChangeRef.current(batch);
			}, 300);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unlisten.then((fn) => fn()).catch(() => {});
			fsApi.watchStop(root).catch(() => {});
		};
	}, [root, enabled]);
}

/** An image File window: read-only, and re-read when the file changes. */
function ImageWindow({ info }: { info: FileWindowInfo }) {
	const [image, setImage] = useState<{ content: string; mime: string } | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	useReadOnlyWindowChrome();

	const load = useCallback(() => {
		fsApi
			.readFile(info.filePath)
			.then((file) => {
				if (file.fileType !== "image" || !file.content) {
					setError("It is not an image this window can show.");
					return;
				}
				setError(null);
				setImage({ content: file.content, mime: file.mime ?? "image/png" });
			})
			.catch((e) => setError(String(e)));
	}, [info.filePath]);
	useEffect(load, [load]);

	useFolderChanges(info.rootFolder, true, (change) => {
		if (change.removedFiles.includes(info.filePath)) {
			setError("The file was deleted.");
		} else if (change.changedFiles.includes(info.filePath)) {
			load();
		}
	});

	const name = fileNameOf(info.filePath);
	return (
		<Shell>
			<FileWindowToolbar fileName={name} workspaceName={info.workspaceName} />
			<div className="flex-1 min-h-0">
				{error ? (
					<Notice>This image could not be shown. {error}</Notice>
				) : image ? (
					<ImageViewer
						content={image.content}
						mime={image.mime}
						fileName={name}
					/>
				) : null}
			</div>
		</Shell>
	);
}

/** Whether a diff has nothing in it: both sides the same. */
function diffIsEmpty(diff: GitFileDiff): boolean {
	return diff.original === diff.modified;
}

/** Two spellings of one path compare equal: the watcher reports native
 *  separators, `resolveWorkspacePath` joins with `/`. */
const samePath = (a: string, b: string) =>
	a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

/**
 * A diff File window, read-only. A commit's diff (`commit-diff`) is frozen
 * history, read once. A live diff (`diff`) is read again when:
 *
 * - its file changes on disk;
 * - git reports a ref change (`git-change`: a commit, a branch switch, a
 *   moved base branch);
 * - the window gains focus. This is the only signal for staging from a
 *   terminal: `.git/index` is deliberately not watched (see `stagePath` in
 *   `lib/ipc.ts`), so nothing in the app hears a bare `git add`.
 */
function DiffWindow({ info }: { info: FileWindowInfo }) {
	const [diff, setDiff] = useState<GitFileDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const live = info.kind === "diff";
	useReadOnlyWindowChrome();
	// Reads overlap (a change, then focus, then a reload to another section);
	// only the newest one's reply may land, or an overtaken read would show the
	// old section's diff under the new title.
	const latestRead = useRef(0);

	const load = useCallback(() => {
		const read = ++latestRead.current;
		const request =
			info.kind === "commit-diff" && info.commitOid
				? gitApi.commitFileDiff(info.rootFolder, info.commitOid, info.filePath)
				: gitApi.fileDiff(
						info.rootFolder,
						info.filePath,
						info.diffSection ?? "unstaged",
						info.baseBranch,
					);
		request
			.then((d) => {
				if (read !== latestRead.current) return;
				setError(null);
				setDiff(d);
			})
			.catch((e) => {
				if (read === latestRead.current) setError(String(e));
			});
	}, [info]);
	useEffect(load, [load]);

	const absolutePath = resolveWorkspacePath(info.rootFolder, info.filePath);
	useFolderChanges(info.rootFolder, live, (change) => {
		const touched = [...change.changedFiles, ...change.removedFiles];
		if (touched.some((p) => samePath(p, absolutePath))) load();
	});
	useEffect(() => {
		if (!live) return;
		const win = appWindow();
		const unlistenFocus = win?.onFocusChanged(({ payload: focused }) => {
			if (focused) load();
		});
		const unlistenGit = fsApi.onGitChange(info.rootFolder, load);
		return () => {
			unlistenFocus?.then((fn) => fn()).catch(() => {});
			unlistenGit.then((fn) => fn()).catch(() => {});
		};
	}, [live, load, info.rootFolder]);

	const name = fileNameOf(info.filePath);
	const shown =
		info.kind === "commit-diff" && info.commitOid
			? `${name} @ ${info.commitOid.slice(0, 7)}`
			: `${name} (diff)`;

	return (
		<Shell>
			<FileWindowToolbar fileName={shown} workspaceName={info.workspaceName} />
			<div className="flex-1 min-h-0 flex flex-col">
				{error ? (
					<Notice>This diff could not be shown. {error}</Notice>
				) : !diff ? null : diffIsEmpty(diff) ? (
					<Notice>
						{live
							? "No changes. This file matches git in this section."
							: "This commit did not change the file's text."}
					</Notice>
				) : (
					<DiffViewer
						diff={diff}
						isActive
						onOpenFile={() => {
							void openFileWindowForPath(info.workspaceId, absolutePath);
						}}
					/>
				)}
			</div>
		</Shell>
	);
}

function Notice({ children }: { children: React.ReactNode }) {
	return (
		<div
			style={{
				padding: "24px 28px",
				color: "var(--fg-secondary)",
				fontSize: 13,
			}}
		>
			{children}
		</div>
	);
}

function LoadError({ message }: { message: string }) {
	return (
		<Shell>
			<Notice>This file could not be opened. {message}</Notice>
		</Shell>
	);
}

function Shell({ children }: { children?: React.ReactNode }) {
	return (
		<div
			className="fixed inset-0 flex flex-col"
			style={{ background: "var(--bg-primary)", color: "var(--fg-primary)" }}
		>
			{children}
		</div>
	);
}
