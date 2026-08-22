import { describe, expect, it } from "vitest";
import { defineAbundioTheme, detectLanguage } from "../monacoShared";

describe("detectLanguage", () => {
	it("detects astro files", () => {
		expect(detectLanguage("src/pages/index.astro")).toBe("astro");
		expect(detectLanguage("Index.ASTRO")).toBe("astro");
	});

	it("detects common languages from the path extension", () => {
		expect(detectLanguage("foo.ts")).toBe("typescript");
		expect(detectLanguage("foo.tsx")).toBe("typescript");
		expect(detectLanguage("foo.rs")).toBe("rust");
		expect(detectLanguage("foo.cls")).toBe("apex");
	});

	it("returns undefined for unknown or extensionless paths", () => {
		expect(detectLanguage("foo.unknownext")).toBeUndefined();
		expect(detectLanguage("Makefile")).toBeUndefined();
	});
});

describe("defineAbundioTheme", () => {
	// Each case passes a distinct --bg-primary on purpose: it is part of
	// defineAbundioTheme's cache key, so reusing one would silently skip the
	// redefine and assert against the previous case's colours.
	function capture(bgPrimary: string) {
		const root = document.documentElement;
		for (const [name, value] of Object.entries({
			"--bg-primary": bgPrimary,
			"--bg-secondary": "#181818",
			"--bg-tertiary": "#242424",
			"--fg-primary": "#e6e6e6",
			"--fg-secondary": "#9a9a9a",
			"--accent": "#4ec9b0",
			"--border": "#2b2b2b",
			"--success": "#3fb950",
			"--error": "#f85149",
		})) {
			root.style.setProperty(name, value);
		}

		let colors: Record<string, string> = {};
		const monaco = {
			editor: {
				defineTheme: (_name: string, theme: { colors: typeof colors }) => {
					colors = theme.colors;
				},
			},
			languages: {
				getLanguages: () => [],
				register: () => {},
				setMonarchTokensProvider: () => {},
				setLanguageConfiguration: () => {},
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal Monaco stand-in
		} as any;
		defineAbundioTheme(monaco);
		return colors;
	}

	it("gives sticky scroll an opaque background of its own", () => {
		// It defaults to `editor.background`, which is deliberately transparent so
		// the workspace gradient shows through — leaving the scrolling text
		// visible straight through the pinned rows.
		const colors = capture("#101010");
		expect(colors["editor.background"]).toBe("#00000000");
		expect(colors["editorStickyScroll.background"]).toBe("#101010");
	});

	it("covers the gutter half too", () => {
		// `editorGutter.background` is transparent for the same reason, and the
		// gutter is a separate element with a separate colour id.
		const colors = capture("#111111");
		expect(colors["editorGutter.background"]).toBe("#00000000");
		expect(colors["editorStickyScrollGutter.background"]).toBe("#111111");
	});

	it("separates the pinned rows from the text below", () => {
		const colors = capture("#121212");
		expect(colors["editorStickyScroll.border"]).toBe("#2b2b2b");
	});
});
