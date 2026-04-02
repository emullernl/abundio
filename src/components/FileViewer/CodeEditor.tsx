import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { setAllTerminalsFontSize } from "../../lib/terminalManager";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { abundioTheme, getLanguageExtension } from "../../lib/codemirrorShared";

interface CodeEditorProps {
	tabId: string;
	isActive: boolean;
	content: string;
	language: string | null;
	initialEditorState: SerializedEditorState | null;
	onChange: (content: string) => void;
}

// Cache EditorState + scroll per tab so switching tabs preserves cursor/scroll
const stateCache = new Map<string, { state: EditorState; scrollTop: number; scrollLeft: number }>();

// Live EditorView instances (mounted editors) — keyed by tabId
const liveViews = new Map<string, EditorView>();

// Last-known scroll positions — updated by scroll listener, survives display:none
const lastKnownScroll = new Map<string, { scrollTop: number; scrollLeft: number }>();

export interface SerializedEditorState {
	cursorPos: number;
	anchorPos: number;
	scrollTop: number;
	scrollLeft: number;
}

export function focusEditor(tabId: string) {
	liveViews.get(tabId)?.focus();
}

export function clearEditorStateCache(tabId: string) {
	stateCache.delete(tabId);
	lastKnownScroll.delete(tabId);
}

/** Extract serializable cursor/scroll — uses tracked scroll (survives display:none) */
export function getSerializableEditorState(tabId: string): SerializedEditorState | null {
	const live = liveViews.get(tabId);
	if (live) {
		const sel = live.state.selection.main;
		const scroll = lastKnownScroll.get(tabId) ?? { scrollTop: 0, scrollLeft: 0 };
		return {
			cursorPos: sel.head,
			anchorPos: sel.anchor,
			scrollTop: scroll.scrollTop,
			scrollLeft: scroll.scrollLeft,
		};
	}
	const cached = stateCache.get(tabId);
	if (!cached) return null;
	const sel = cached.state.selection.main;
	return {
		cursorPos: sel.head,
		anchorPos: sel.anchor,
		scrollTop: cached.scrollTop,
		scrollLeft: cached.scrollLeft,
	};
}

export function CodeEditor({ tabId, isActive, content, language, initialEditorState, onChange }: CodeEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const tabIdRef = useRef(tabId);
	tabIdRef.current = tabId;
	const langCompartmentRef = useRef(new Compartment());
	// Code editor intentionally uses the terminal (monospace) font, not the UI font
	const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);

	// Focus editor when it becomes the active visible tab
	const isFileView = useSessionStore((s) => {
		const sid = s.activeSessionId;
		return sid ? (s.activeView[sid] ?? "terminal") === "file" : false;
	});

	useEffect(() => {
		if (isActive && isFileView && viewRef.current) {
			const view = viewRef.current;
			// Double rAF: first waits for display:none→block commit, second for layout
			requestAnimationFrame(() => {
				requestAnimationFrame(() => view.focus());
			});
		}
	}, [isActive, isFileView]);

	// Capture-phase keydown on the container to intercept before CodeMirror
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		function handleKeyDown(e: KeyboardEvent) {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod || e.shiftKey) return;

			if (e.key === "=" || e.key === "+") {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				const { fontSize, setFontSize } = useSettingsStore.getState();
				const newSize = Math.min(fontSize + 1, 32);
				setFontSize(newSize);
				setAllTerminalsFontSize(newSize);
			} else if (e.key === "-") {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				const { fontSize, setFontSize } = useSettingsStore.getState();
				const newSize = Math.max(fontSize - 1, 8);
				setFontSize(newSize);
				setAllTerminalsFontSize(newSize);
			} else if (e.key === "s") {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				const { activeFileTabId } = useExplorerStore.getState();
				if (activeFileTabId) {
					useExplorerStore.getState().saveFile(activeFileTabId);
				}
			}
		}

		el.addEventListener("keydown", handleKeyDown, true);
		return () => el.removeEventListener("keydown", handleKeyDown, true);
	}, []);

	// Create EditorView synchronously so cleanup always has access to it.
	// Language extensions are loaded async and applied via Compartment.
	useEffect(() => {
		if (!containerRef.current) return;

		const currentTabId = tabIdRef.current;
		const langCompartment = langCompartmentRef.current;

		// Prefer initialEditorState (from DB restore) over stateCache
		// to avoid StrictMode double-mount poisoning the cache
		let doc = content;
		let selection: { anchor: number; head: number } | undefined;
		let targetScrollTop = 0;
		let targetScrollLeft = 0;

		if (initialEditorState) {
			selection = {
				anchor: Math.min(initialEditorState.anchorPos, content.length),
				head: Math.min(initialEditorState.cursorPos, content.length),
			};
			targetScrollTop = initialEditorState.scrollTop;
			targetScrollLeft = initialEditorState.scrollLeft;
		} else {
			const cached = stateCache.get(currentTabId);
			if (cached) {
				doc = cached.state.doc.toString();
				const sel = cached.state.selection.main;
				selection = { anchor: sel.anchor, head: sel.head };
				targetScrollTop = cached.scrollTop;
				targetScrollLeft = cached.scrollLeft;
			}
		}

		const extensions = [
			lineNumbers(),
			highlightActiveLine(),
			highlightSpecialChars(),
			history(),
			bracketMatching(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			oneDark,
			abundioTheme,
			keymap.of([...defaultKeymap, ...historyKeymap]),
			langCompartment.of([]),
			EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					onChangeRef.current(update.state.doc.toString());
				}
			}),
		];

		const state = EditorState.create({ doc, extensions, selection });
		const view = new EditorView({ state, parent: containerRef.current });

		viewRef.current = view;
		liveViews.set(currentTabId, view);

		// Restore scroll — use ResizeObserver to wait until the element is visible
		// (display:none elements have 0 size, so scrollTop assignment is a no-op)
		let scrollRestored = false;
		const restoreScroll = () => {
			if (scrollRestored) return;
			view.scrollDOM.scrollTop = targetScrollTop;
			view.scrollDOM.scrollLeft = targetScrollLeft;
			if (view.scrollDOM.scrollTop > 0 || targetScrollTop === 0) {
				scrollRestored = true;
			}
		};

		let resizeObserver: ResizeObserver | null = null;
		if (targetScrollTop || targetScrollLeft) {
			restoreScroll(); // try immediately
			if (!scrollRestored) {
				resizeObserver = new ResizeObserver(() => {
					if (view.scrollDOM.clientHeight > 0) {
						restoreScroll();
						if (scrollRestored) {
							resizeObserver?.disconnect();
							resizeObserver = null;
						}
					}
				});
				resizeObserver.observe(view.scrollDOM);
			}
		}

		// Load language extension async and reconfigure into the compartment
		let cancelled = false;
		getLanguageExtension(language).then((langExt) => {
			if (!cancelled && langExt.length > 0) {
				view.dispatch({
					effects: langCompartment.reconfigure(langExt),
				});
			}
		});

		// Track scroll in module-level Map so it survives display:none
		lastKnownScroll.set(currentTabId, { scrollTop: targetScrollTop, scrollLeft: targetScrollLeft });
		const scroller = view.scrollDOM;
		const onScroll = () => {
			lastKnownScroll.set(currentTabId, {
				scrollTop: scroller.scrollTop,
				scrollLeft: scroller.scrollLeft,
			});
		};
		scroller.addEventListener("scroll", onScroll);

		return () => {
			resizeObserver?.disconnect();
			scroller.removeEventListener("scroll", onScroll);
			cancelled = true;
			liveViews.delete(currentTabId);
			const scroll = lastKnownScroll.get(currentTabId) ?? { scrollTop: 0, scrollLeft: 0 };
			stateCache.set(currentTabId, {
				state: view.state,
				scrollTop: scroll.scrollTop,
				scrollLeft: scroll.scrollLeft,
			});
			lastKnownScroll.delete(currentTabId);
			view.destroy();
			viewRef.current = null;
		};
	}, [language]);

	// Update content when it changes externally (e.g., file reload)
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const currentContent = view.state.doc.toString();
		if (currentContent !== content) {
			view.dispatch({
				changes: { from: 0, to: currentContent.length, insert: content },
			});
		}
	}, [content]);

	return (
		<div
			ref={containerRef}
			className="h-full w-full overflow-hidden"
			style={{
				backgroundColor: "var(--bg-primary)",
				"--cm-font-size": `${fontSize}px`,
				"--cm-font-family": fontFamily,
			} as React.CSSProperties}
		/>
	);
}
