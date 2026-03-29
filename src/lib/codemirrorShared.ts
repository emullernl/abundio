import { EditorView } from "@codemirror/view";

export const abundioTheme = EditorView.theme({
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

export async function getLanguageExtension(language: string | null) {
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

export function detectLanguage(filePath: string): string | null {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return null;
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		html: "html",
		css: "css",
		json: "json",
		md: "markdown",
		py: "python",
		rs: "rust",
		cpp: "cpp",
		c: "cpp",
		h: "cpp",
		hpp: "cpp",
		java: "java",
	};
	return map[ext] ?? null;
}
