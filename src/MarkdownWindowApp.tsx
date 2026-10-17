import { open } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeEditor } from "./components/FileViewer/CodeEditor";
import { FileChangeBanner } from "./components/FileViewer/FileChangeBanner";
import { MarkdownRendered } from "./components/FileViewer/MarkdownRendered";
import { MarkdownFindBar } from "./components/MarkdownWindow/MarkdownFindBar";
import { MarkdownWindowToolbar } from "./components/MarkdownWindow/MarkdownWindowToolbar";
import "./components/MarkdownWindow/MarkdownWindow.css";
import { SaveConfirmDialog } from "./components/SaveConfirmDialog";
import { useShortcutLabel } from "./hooks/useShortcutLabel";
import { appWindow } from "./lib/appWindow";
import {
	fs as fsApi,
	type MarkdownView,
	type MarkdownWindowInfo,
	markdownWindows,
} from "./lib/ipc";
import {
	initKeybindings,
	registerAction,
	setKeybindingOverrides,
	unregisterAction,
} from "./lib/keybindings";
import { classifyMarkdownLink, scrollToFragment } from "./lib/markdownLinks";
import { printMarkdownPreview } from "./lib/markdownPrint";
import {
	diskChanged,
	diskRemoved,
	edited,
	isDirty,
	keptEdits,
	loadedBuffer,
	type MarkdownBuffer,
	reloaded,
	savedBuffer,
} from "./lib/markdownWindowBuffer";
import { applyMonacoOverrides } from "./lib/monacoKeymap";
import { resolvePreviewColorMode } from "./lib/previewColorMode";
import { getTheme } from "./lib/themes";
import { requestSettingsSnapshot } from "./SettingsApp";
import type { FilePaneState } from "./stores/explorerStore";
import { useSettingsStore } from "./stores/settingsStore";

// Base editor font size — the rendered zoom follows Cmd+= / Cmd+- like the
// Preview pane does.
const BASE_FONT_SIZE = 14;
// CodeEditor caches view state by this id. One editor per window.
const EDITOR_ID = "markdown-window";

// Either separator: Windows paths come back with backslashes.
const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || path;
const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");

/**
 * Root of a **Markdown window** (label `md-<uuid>`): one markdown file of a
 * Workspace, rendered (read-only) or as Monaco source. See ADR-0046.
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
export function MarkdownWindowApp() {
	const [info, setInfo] = useState<MarkdownWindowInfo | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [buffer, setBuffer] = useState<MarkdownBuffer | null>(null);
	const [view, setView] = useState<MarkdownView>("rendered");
	const [findOpen, setFindOpen] = useState(false);
	const [confirmClose, setConfirmClose] = useState(false);
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
		requestSettingsSnapshot();
		(async () => {
			try {
				const i = await markdownWindows.info();
				setInfo(i);
				setView(i.view);
				const file = await fsApi.readFile(i.filePath);
				if (file.fileType !== "text") {
					setLoadError("This file is not text.");
					return;
				}
				setBuffer(loadedBuffer(file.content ?? ""));
			} catch (e) {
				setLoadError(String(e));
			}
		})();
	}, []);

	// The owning Window asks Rust, not us, whether we have unsaved edits.
	useEffect(() => {
		markdownWindows.setDirty(dirty).catch(() => {});
	}, [dirty]);

	const save = useCallback(async () => {
		const b = bufferRef.current;
		const i = infoRef.current;
		if (!b || !i) return;
		await fsApi.writeFile(i.filePath, b.content);
		// Edits typed while the write was in flight stay dirty.
		setBuffer((cur) =>
			cur ? { ...savedBuffer(b), content: cur.content } : cur,
		);
	}, []);

	// The owner's "Save" before it closes a Workspace.
	useEffect(() => {
		const unlisten = markdownWindows.onSaveRequested(() => {
			save().catch((e) => console.error("[markdown-window] save failed:", e));
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
		await markdownWindows.forget().catch(() => {});
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
		markdownWindows.setView(next).catch(() => {});
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
			save().catch((e) => console.error("[markdown-window] save failed:", e));
		});
		// The "Toggle markdown preview" chord swaps the view here.
		registerAction("toggle-markdown-preview", () =>
			changeView(viewRef.current === "rendered" ? "source" : "rendered"),
		);
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
	}, [save, changeView, requestClose]);

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
				markdownWindows.open(i.workspaceId, action.path).catch((e) => {
					console.error("[markdown-window] open link failed:", e);
				});
				return;
			default:
				return;
		}
	}, []);

	if (loadError) {
		return (
			<Shell>
				<div
					style={{
						padding: "24px 28px",
						color: "var(--fg-secondary)",
						fontSize: 13,
					}}
				>
					This file could not be opened. {loadError}
				</div>
			</Shell>
		);
	}
	if (!info || !buffer) return <Shell />;

	// FileChangeBanner reads only the change flags off a File pane's state.
	const bannerState = {
		isDirty: dirty,
		externallyChanged: buffer.externallyChanged,
		deletedOnDisk: buffer.deletedOnDisk,
	} as FilePaneState;

	return (
		<Shell>
			<MarkdownWindowToolbar
				fileName={fileNameOf(info.filePath)}
				workspaceName={info.workspaceName}
				dirty={dirty}
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
						language="markdown"
						initialEditorState={null}
						onChange={(content) =>
							setBuffer((b) => (b ? edited(b, content) : b))
						}
						forceWordWrap
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
							console.error("[markdown-window] save failed:", e);
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
