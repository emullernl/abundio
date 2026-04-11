import type { Monaco } from "@monaco-editor/react";

/**
 * Resolve a CSS custom property from :root to its computed hex value.
 */
function resolve(varName: string): string {
	return getComputedStyle(document.documentElement)
		.getPropertyValue(varName)
		.trim();
}

/**
 * (Re-)define the "abundio" Monaco theme from the current CSS variables.
 * Call this once on init and again whenever the app theme changes.
 */
export function defineAbundioTheme(monaco: Monaco) {
	monaco.editor.defineTheme("abundio", {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": resolve("--bg-primary"),
			"editor.foreground": resolve("--fg-primary"),
			"editorLineNumber.foreground": resolve("--fg-secondary"),
			"editorLineNumber.activeForeground": resolve("--fg-primary"),
			"editorCursor.foreground": resolve("--accent"),
			"editor.selectionBackground": `${resolve("--accent")}40`,
			"editor.lineHighlightBackground": `${resolve("--fg-primary")}0D`,
			"editorGutter.background": resolve("--bg-secondary"),
			"editorWidget.background": resolve("--bg-secondary"),
			"editorWidget.border": resolve("--border"),
			"editor.findMatchBackground": `${resolve("--accent")}40`,
			"editor.findMatchHighlightBackground": `${resolve("--accent")}25`,
			"editorOverviewRuler.border": resolve("--border"),
			"scrollbarSlider.background": `${resolve("--fg-secondary")}40`,
			"scrollbarSlider.hoverBackground": `${resolve("--fg-secondary")}60`,
			"scrollbarSlider.activeBackground": `${resolve("--fg-secondary")}80`,
			// Diff colors
			"diffEditor.insertedTextBackground": `${resolve("--success")}20`,
			"diffEditor.removedTextBackground": `${resolve("--error")}20`,
			"diffEditor.insertedLineBackground": `${resolve("--success")}14`,
			"diffEditor.removedLineBackground": `${resolve("--error")}14`,
		},
	});
}

/**
 * Detect the Monaco language ID from a file path's extension.
 */
export function detectLanguage(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
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
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		yaml: "yaml",
		yml: "yaml",
		toml: "ini",
		xml: "xml",
		svg: "xml",
		sql: "sql",
		go: "go",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		lua: "lua",
		r: "r",
		dockerfile: "dockerfile",
		cls: "apex",
		trigger: "apex",
		apex: "apex",
	};
	return map[ext];
}
