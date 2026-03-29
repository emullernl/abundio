import { describe, it, expect } from "vitest";
import { themes, applyTheme, getTheme, themeList } from "../themes";

describe("getTheme", () => {
	it("returns the correct theme by name", () => {
		expect(getTheme("default").name).toBe("default");
		expect(getTheme("dracula").name).toBe("dracula");
		expect(getTheme("catppuccin").name).toBe("catppuccin");
	});

	it("falls back to default for unknown name", () => {
		const theme = getTheme("nonexistent");
		expect(theme.name).toBe("default");
		expect(theme.displayName).toBe("Abundio Dark");
	});
});

describe("themeList", () => {
	it("returns all 12 themes", () => {
		expect(themeList()).toHaveLength(12);
	});

	it("every theme has required shape", () => {
		const uiKeys = [
			"bgPrimary", "bgSecondary", "bgTertiary",
			"fgPrimary", "fgSecondary",
			"accent", "accentHover", "border",
			"error", "warning", "success",
		];
		const terminalKeys = [
			"background", "foreground", "cursor", "selectionBackground",
			"black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
			"brightBlack", "brightRed", "brightGreen", "brightYellow",
			"brightBlue", "brightMagenta", "brightCyan", "brightWhite",
		];

		for (const theme of themeList()) {
			expect(theme).toHaveProperty("name");
			expect(theme).toHaveProperty("displayName");
			for (const key of uiKeys) {
				expect(theme.ui).toHaveProperty(key);
			}
			for (const key of terminalKeys) {
				expect(theme.terminal).toHaveProperty(key);
			}
		}
	});

	it("includes all expected theme names", () => {
		const names = themeList().map((t) => t.name);
		for (const name of [
			"default", "dracula", "catppuccin", "tokyoNight", "oneDark",
			"gruvbox", "nord", "solarizedDark", "kanagawa", "rosePine",
			"moonlight", "vesper",
		]) {
			expect(names).toContain(name);
		}
	});
});

describe("applyTheme", () => {
	it("sets all CSS variables on document root", () => {
		applyTheme(themes.dracula);
		const root = document.documentElement;
		expect(root.style.getPropertyValue("--bg-primary")).toBe("#282A36");
		expect(root.style.getPropertyValue("--bg-secondary")).toBe("#21222C");
		expect(root.style.getPropertyValue("--bg-tertiary")).toBe("#343746");
		expect(root.style.getPropertyValue("--fg-primary")).toBe("#F8F8F2");
		expect(root.style.getPropertyValue("--fg-secondary")).toBe("#6272A4");
		expect(root.style.getPropertyValue("--accent")).toBe("#BD93F9");
		expect(root.style.getPropertyValue("--accent-hover")).toBe("#CFA9FF");
		expect(root.style.getPropertyValue("--border")).toBe("#44475A");
		expect(root.style.getPropertyValue("--error")).toBe("#FF5555");
		expect(root.style.getPropertyValue("--warning")).toBe("#F1FA8C");
		expect(root.style.getPropertyValue("--success")).toBe("#50FA7B");
	});

	it("overwrites previous theme variables", () => {
		applyTheme(themes.default);
		applyTheme(themes.nord);
		const root = document.documentElement;
		expect(root.style.getPropertyValue("--bg-primary")).toBe("#2E3440");
	});
});
