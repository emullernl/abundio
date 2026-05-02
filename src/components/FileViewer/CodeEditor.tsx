import Editor, { type Monaco, useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useRef } from "react";
import { defineAbundioTheme } from "../../lib/monacoShared";
import { setAllTerminalsFontSize } from "../../lib/terminalManager";
import { setMonacoInstance } from "../../lib/themes";
import { useExplorerStore } from "../../stores/explorerStore";
import { useSettingsStore } from "../../stores/settingsStore";

interface CodeEditorProps {
	tabId: string;
	isActive: boolean;
	content: string;
	language: string | null;
	initialEditorState: SerializedEditorState | null;
	onChange: (content: string) => void;
}

// Cache view state per tab so switching tabs preserves cursor/scroll
const stateCache = new Map<string, editor.ICodeEditorViewState>();

// Live editor instances (mounted editors) — keyed by tabId
const liveEditors = new Map<string, editor.IStandaloneCodeEditor>();

export interface SerializedEditorState {
	cursorPos: number;
	anchorPos: number;
	scrollTop: number;
	scrollLeft: number;
}

export function focusEditor(tabId: string) {
	liveEditors.get(tabId)?.focus();
}

export function triggerEditorAction(tabId: string, actionId: string): void {
	liveEditors.get(tabId)?.trigger("contextmenu", actionId, null);
}

export function clearEditorStateCache(tabId: string) {
	stateCache.delete(tabId);
}

/** Extract serializable cursor/scroll state */
export function getSerializableEditorState(
	tabId: string,
): SerializedEditorState | null {
	const live = liveEditors.get(tabId);
	if (live) {
		const pos = live.getPosition();
		const sel = live.getSelection();
		return {
			cursorPos: (pos ? live.getModel()?.getOffsetAt(pos) : 0) ?? 0,
			anchorPos: sel
				? (live.getModel()?.getOffsetAt({
						lineNumber: sel.startLineNumber,
						column: sel.startColumn,
					}) ?? 0)
				: 0,
			scrollTop: live.getScrollTop(),
			scrollLeft: live.getScrollLeft(),
		};
	}

	// Fall back to cached state — reconstruct from view state
	const cached = stateCache.get(tabId);
	if (!cached) return null;

	return {
		cursorPos: 0,
		anchorPos: 0,
		scrollTop: cached.viewState?.scrollTop ?? 0,
		scrollLeft: cached.viewState?.scrollLeft ?? 0,
	};
}

export function CodeEditor({
	tabId,
	isActive,
	content,
	language,
	initialEditorState,
	onChange,
}: CodeEditorProps) {
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const tabIdRef = useRef(tabId);
	tabIdRef.current = tabId;

	const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const monacoFontSize = fontSize - 1;
	const editorWordWrap = useSettingsStore((s) => s.editorWordWrap);
	const monaco = useMonaco();

	const pendingGotoLine = useExplorerStore((s) => s.pendingGotoLine);

	// Focus editor when this pane becomes active
	useEffect(() => {
		if (isActive && editorRef.current) {
			const ed = editorRef.current;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => ed.focus());
			});
		}
	}, [isActive]);

	// Handle pending go-to-line from search results
	useEffect(() => {
		if (!isActive || !pendingGotoLine || !editorRef.current) return;
		const pane = useExplorerStore.getState().filePanes[tabId];
		if (!pane || pane.filePath !== pendingGotoLine.filePath) return;

		const ed = editorRef.current;
		const line = pendingGotoLine.line;
		ed.revealLineInCenter(line);
		ed.setPosition({ lineNumber: line, column: 1 });
		ed.focus();
		useExplorerStore.getState().setPendingGotoLine(null);
	}, [isActive, pendingGotoLine, tabId]);

	// Update font when settings change
	useEffect(() => {
		editorRef.current?.updateOptions({ fontFamily, fontSize: monacoFontSize });
	}, [fontFamily, monacoFontSize]);

	// Update word-wrap on live editors when the global setting changes
	useEffect(() => {
		editorRef.current?.updateOptions({
			wordWrap: editorWordWrap ? "on" : "off",
		});
	}, [editorWordWrap]);

	// Re-define theme when it might have changed (monaco instance available)
	useEffect(() => {
		if (monaco) {
			defineAbundioTheme(monaco);
			monaco.editor.setTheme("abundio");
		}
	}, [monaco]);

	const handleMount = useCallback(
		(ed: editor.IStandaloneCodeEditor, m: Monaco) => {
			editorRef.current = ed;
			liveEditors.set(tabIdRef.current, ed);

			// Define and apply theme, store Monaco instance for theme sync
			defineAbundioTheme(m);
			m.editor.setTheme("abundio");
			setMonacoInstance(m);

			// Restore view state from initialEditorState or cache
			if (initialEditorState) {
				const model = ed.getModel();
				if (model) {
					const pos = model.getPositionAt(initialEditorState.cursorPos);
					ed.setPosition(pos);
					ed.setScrollTop(initialEditorState.scrollTop);
					ed.setScrollLeft(initialEditorState.scrollLeft);
				}
			} else {
				const cached = stateCache.get(tabIdRef.current);
				if (cached) {
					ed.restoreViewState(cached);
				}
			}

			// Register keybindings
			// biome-ignore lint/style/noNonNullAssertion: Monaco KeyMod/KeyCode exist at runtime
			const KeyMod = m.KeyMod!;
			// biome-ignore lint/style/noNonNullAssertion: Monaco KeyMod/KeyCode exist at runtime
			const KeyCode = m.KeyCode!;

			// Cmd+S → save file
			ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => {
				useExplorerStore.getState().saveFile(tabIdRef.current);
			});

			// Cmd+= → zoom in
			ed.addCommand(KeyMod.CtrlCmd | KeyCode.Equal, () => {
				const { fontSize: fs, setFontSize } = useSettingsStore.getState();
				const newSize = Math.min(fs + 1, 32);
				setFontSize(newSize);
				setAllTerminalsFontSize(newSize);
			});

			// Cmd+- → zoom out
			ed.addCommand(KeyMod.CtrlCmd | KeyCode.Minus, () => {
				const { fontSize: fs, setFontSize } = useSettingsStore.getState();
				const newSize = Math.max(fs - 1, 8);
				setFontSize(newSize);
				setAllTerminalsFontSize(newSize);
			});

			// Toggle word-wrap (right-click menu + F1 palette)
			ed.addAction({
				id: "abundio.toggleWordWrap",
				label: "Toggle Word Wrap",
				contextMenuGroupId: "view",
				contextMenuOrder: 1.5,
				run: () => useSettingsStore.getState().toggleEditorWordWrap(),
			});
		},
		[initialEditorState],
	);

	// Save view state on unmount
	useEffect(() => {
		const currentTabId = tabIdRef.current;
		return () => {
			const ed = liveEditors.get(currentTabId);
			if (ed) {
				const viewState = ed.saveViewState();
				if (viewState) {
					stateCache.set(currentTabId, viewState);
				}
				liveEditors.delete(currentTabId);
			}
		};
	}, []);

	const monacoLanguage = language ?? undefined;

	return (
		<div
			className="h-full w-full overflow-hidden"
			style={{ backgroundColor: "var(--bg-primary)" }}
		>
			<Editor
				height="100%"
				language={monacoLanguage}
				value={content}
				theme="abundio"
				onChange={(value) => {
					if (value !== undefined) {
						onChangeRef.current(value);
					}
				}}
				onMount={handleMount}
				options={{
					fontFamily,
					fontSize: monacoFontSize,
					wordWrap: editorWordWrap ? "on" : "off",
					contextmenu: false,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					lineNumbers: "on",
					renderLineHighlight: "line",
					matchBrackets: "always",
					automaticLayout: true,
					padding: { top: 8 },
					overviewRulerLanes: 0,
					hideCursorInOverviewRuler: true,
					scrollbar: {
						verticalScrollbarSize: 10,
						horizontalScrollbarSize: 10,
					},
				}}
			/>
		</div>
	);
}
