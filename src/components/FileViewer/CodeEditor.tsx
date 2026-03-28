import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
import { useSettingsStore } from "../../stores/settingsStore";
import { useExplorerStore } from "../../stores/explorerStore";
import { setAllTerminalsFontSize } from "../../lib/terminalManager";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";

interface CodeEditorProps {
	content: string;
	language: string | null;
	onChange: (content: string) => void;
}

async function getLanguageExtension(language: string | null) {
	if (!language) return [];
	switch (language) {
		case "typescript": {
			const { javascript } = await import("@codemirror/lang-javascript");
			return [javascript({ typescript: true, jsx: true })];
		}
		case "javascript": {
			const { javascript } = await import("@codemirror/lang-javascript");
			return [javascript({ jsx: true })];
		}
		case "html": {
			const { html } = await import("@codemirror/lang-html");
			return [html()];
		}
		case "css": {
			const { css } = await import("@codemirror/lang-css");
			return [css()];
		}
		case "json": {
			const { json } = await import("@codemirror/lang-json");
			return [json()];
		}
		case "markdown": {
			const { markdown } = await import("@codemirror/lang-markdown");
			return [markdown()];
		}
		case "python": {
			const { python } = await import("@codemirror/lang-python");
			return [python()];
		}
		case "rust": {
			const { rust } = await import("@codemirror/lang-rust");
			return [rust()];
		}
		case "cpp": {
			const { cpp } = await import("@codemirror/lang-cpp");
			return [cpp()];
		}
		case "java": {
			const { java } = await import("@codemirror/lang-java");
			return [java()];
		}
		default:
			return [];
	}
}

// Theme uses CSS custom properties set on the container div,
// so font changes propagate automatically without reconfiguration.
const abundioTheme = EditorView.theme({
	"&": {
		height: "100%",
		fontSize: "var(--cm-font-size)",
		fontFamily: "var(--cm-font-family)",
	},
	".cm-content": {
		caretColor: "var(--accent)",
		padding: "8px 0",
		fontFamily: "var(--cm-font-family)",
		fontSize: "var(--cm-font-size)",
	},
	".cm-cursor, .cm-dropCursor": {
		borderLeftColor: "var(--accent)",
	},
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
	},
	".cm-gutters": {
		backgroundColor: "var(--bg-secondary)",
		color: "var(--fg-secondary)",
		border: "none",
		paddingRight: "8px",
		fontFamily: "var(--cm-font-family)",
		fontSize: "var(--cm-font-size)",
	},
	".cm-activeLineGutter": {
		backgroundColor: "var(--bg-tertiary)",
	},
	".cm-activeLine": {
		backgroundColor: "color-mix(in srgb, var(--fg-primary) 5%, transparent)",
	},
	".cm-scroller": {
		overflow: "auto",
	},
});

export function CodeEditor({ content, language, onChange }: CodeEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);

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

	useEffect(() => {
		if (!containerRef.current) return;

		async function init() {
			if (!containerRef.current) return;

			const langExt = await getLanguageExtension(language);

			const state = EditorState.create({
				doc: content,
				extensions: [
					lineNumbers(),
					highlightActiveLine(),
					highlightSpecialChars(),
					history(),
					bracketMatching(),
					syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
					oneDark,
					abundioTheme,
					keymap.of([...defaultKeymap, ...historyKeymap]),
					...langExt,
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							onChangeRef.current(update.state.doc.toString());
						}
					}),
				],
			});

			const view = new EditorView({
				state,
				parent: containerRef.current,
			});
			viewRef.current = view;
		}

		init();

		return () => {
			if (viewRef.current) {
				viewRef.current.destroy();
				viewRef.current = null;
			}
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
