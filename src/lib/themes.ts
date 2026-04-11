import type { Monaco } from "@monaco-editor/react";
import type { ITheme } from "@xterm/xterm";
import { defineAbundioTheme } from "./monacoShared";

let _monaco: Monaco | null = null;

/** Store the Monaco instance so applyTheme can re-define the editor theme. */
export function setMonacoInstance(monaco: Monaco) {
	_monaco = monaco;
}

export interface AppTheme {
	name: string;
	displayName: string;
	ui: {
		bgPrimary: string;
		bgSecondary: string;
		bgTertiary: string;
		fgPrimary: string;
		fgSecondary: string;
		accent: string;
		accentHover: string;
		border: string;
		error: string;
		warning: string;
		success: string;
	};
	terminal: ITheme;
}

export const themes: Record<string, AppTheme> = {
	default: {
		name: "default",
		displayName: "Abundio Dark",
		ui: {
			bgPrimary: "#0D1117",
			bgSecondary: "#161B22",
			bgTertiary: "#21262D",
			fgPrimary: "#E6EDF3",
			fgSecondary: "#8B949E",
			accent: "#58D5BA",
			accentHover: "#7EE2CC",
			border: "#30363D",
			error: "#F85149",
			warning: "#D29922",
			success: "#3FB950",
		},
		terminal: {
			background: "#0D1117",
			foreground: "#E6EDF3",
			cursor: "#58D5BA",
			selectionBackground: "#264F78",
			black: "#484F58",
			red: "#FF7B72",
			green: "#3FB950",
			yellow: "#D29922",
			blue: "#58A6FF",
			magenta: "#BC8CFF",
			cyan: "#58D5BA",
			white: "#E6EDF3",
			brightBlack: "#6E7681",
			brightRed: "#FFA198",
			brightGreen: "#56D364",
			brightYellow: "#E3B341",
			brightBlue: "#79C0FF",
			brightMagenta: "#D2A8FF",
			brightCyan: "#7EE2CC",
			brightWhite: "#FFFFFF",
		},
	},

	dracula: {
		name: "dracula",
		displayName: "Dracula",
		ui: {
			bgPrimary: "#282A36",
			bgSecondary: "#21222C",
			bgTertiary: "#343746",
			fgPrimary: "#F8F8F2",
			fgSecondary: "#6272A4",
			accent: "#BD93F9",
			accentHover: "#CFA9FF",
			border: "#44475A",
			error: "#FF5555",
			warning: "#F1FA8C",
			success: "#50FA7B",
		},
		terminal: {
			background: "#282A36",
			foreground: "#F8F8F2",
			cursor: "#F8F8F2",
			selectionBackground: "#44475A",
			black: "#21222C",
			red: "#FF5555",
			green: "#50FA7B",
			yellow: "#F1FA8C",
			blue: "#BD93F9",
			magenta: "#FF79C6",
			cyan: "#8BE9FD",
			white: "#F8F8F2",
			brightBlack: "#6272A4",
			brightRed: "#FF6E6E",
			brightGreen: "#69FF94",
			brightYellow: "#FFFFA5",
			brightBlue: "#D6ACFF",
			brightMagenta: "#FF92DF",
			brightCyan: "#A4FFFF",
			brightWhite: "#FFFFFF",
		},
	},

	catppuccin: {
		name: "catppuccin",
		displayName: "Catppuccin Mocha",
		ui: {
			bgPrimary: "#1E1E2E",
			bgSecondary: "#181825",
			bgTertiary: "#313244",
			fgPrimary: "#CDD6F4",
			fgSecondary: "#6C7086",
			accent: "#89B4FA",
			accentHover: "#B4D0FB",
			border: "#45475A",
			error: "#F38BA8",
			warning: "#FAB387",
			success: "#A6E3A1",
		},
		terminal: {
			background: "#1E1E2E",
			foreground: "#CDD6F4",
			cursor: "#F5E0DC",
			selectionBackground: "#45475A",
			black: "#45475A",
			red: "#F38BA8",
			green: "#A6E3A1",
			yellow: "#F9E2AF",
			blue: "#89B4FA",
			magenta: "#F5C2E7",
			cyan: "#94E2D5",
			white: "#BAC2DE",
			brightBlack: "#585B70",
			brightRed: "#F38BA8",
			brightGreen: "#A6E3A1",
			brightYellow: "#F9E2AF",
			brightBlue: "#89B4FA",
			brightMagenta: "#F5C2E7",
			brightCyan: "#94E2D5",
			brightWhite: "#A6ADC8",
		},
	},

	tokyoNight: {
		name: "tokyoNight",
		displayName: "Tokyo Night",
		ui: {
			bgPrimary: "#1A1B26",
			bgSecondary: "#16161E",
			bgTertiary: "#292E42",
			fgPrimary: "#C0CAF5",
			fgSecondary: "#565F89",
			accent: "#7AA2F7",
			accentHover: "#89B4FA",
			border: "#3B4261",
			error: "#F7768E",
			warning: "#E0AF68",
			success: "#9ECE6A",
		},
		terminal: {
			background: "#1A1B26",
			foreground: "#C0CAF5",
			cursor: "#C0CAF5",
			selectionBackground: "#33467C",
			black: "#15161E",
			red: "#F7768E",
			green: "#9ECE6A",
			yellow: "#E0AF68",
			blue: "#7AA2F7",
			magenta: "#BB9AF7",
			cyan: "#7DCFFF",
			white: "#A9B1D6",
			brightBlack: "#414868",
			brightRed: "#F7768E",
			brightGreen: "#9ECE6A",
			brightYellow: "#E0AF68",
			brightBlue: "#7AA2F7",
			brightMagenta: "#BB9AF7",
			brightCyan: "#7DCFFF",
			brightWhite: "#C0CAF5",
		},
	},

	oneDark: {
		name: "oneDark",
		displayName: "One Dark",
		ui: {
			bgPrimary: "#282C34",
			bgSecondary: "#21252B",
			bgTertiary: "#2C313A",
			fgPrimary: "#ABB2BF",
			fgSecondary: "#5C6370",
			accent: "#61AFEF",
			accentHover: "#79BFEF",
			border: "#3E4452",
			error: "#E06C75",
			warning: "#E5C07B",
			success: "#98C379",
		},
		terminal: {
			background: "#282C34",
			foreground: "#ABB2BF",
			cursor: "#528BFF",
			selectionBackground: "#3E4452",
			black: "#3F4451",
			red: "#E06C75",
			green: "#98C379",
			yellow: "#E5C07B",
			blue: "#61AFEF",
			magenta: "#C678DD",
			cyan: "#56B6C2",
			white: "#ABB2BF",
			brightBlack: "#4F5666",
			brightRed: "#BE5046",
			brightGreen: "#98C379",
			brightYellow: "#D19A66",
			brightBlue: "#61AFEF",
			brightMagenta: "#C678DD",
			brightCyan: "#56B6C2",
			brightWhite: "#D7DAE0",
		},
	},

	gruvbox: {
		name: "gruvbox",
		displayName: "Gruvbox Dark",
		ui: {
			bgPrimary: "#282828",
			bgSecondary: "#1D2021",
			bgTertiary: "#3C3836",
			fgPrimary: "#EBDBB2",
			fgSecondary: "#928374",
			accent: "#FE8019",
			accentHover: "#FABD2F",
			border: "#504945",
			error: "#FB4934",
			warning: "#FABD2F",
			success: "#B8BB26",
		},
		terminal: {
			background: "#282828",
			foreground: "#EBDBB2",
			cursor: "#EBDBB2",
			selectionBackground: "#504945",
			black: "#282828",
			red: "#CC241D",
			green: "#98971A",
			yellow: "#D79921",
			blue: "#458588",
			magenta: "#B16286",
			cyan: "#689D6A",
			white: "#A89984",
			brightBlack: "#928374",
			brightRed: "#FB4934",
			brightGreen: "#B8BB26",
			brightYellow: "#FABD2F",
			brightBlue: "#83A598",
			brightMagenta: "#D3869B",
			brightCyan: "#8EC07C",
			brightWhite: "#EBDBB2",
		},
	},

	nord: {
		name: "nord",
		displayName: "Nord",
		ui: {
			bgPrimary: "#2E3440",
			bgSecondary: "#272C36",
			bgTertiary: "#3B4252",
			fgPrimary: "#ECEFF4",
			fgSecondary: "#7B88A1",
			accent: "#88C0D0",
			accentHover: "#8FBCBB",
			border: "#4C566A",
			error: "#BF616A",
			warning: "#EBCB8B",
			success: "#A3BE8C",
		},
		terminal: {
			background: "#2E3440",
			foreground: "#D8DEE9",
			cursor: "#D8DEE9",
			selectionBackground: "#434C5E",
			black: "#3B4252",
			red: "#BF616A",
			green: "#A3BE8C",
			yellow: "#EBCB8B",
			blue: "#81A1C1",
			magenta: "#B48EAD",
			cyan: "#88C0D0",
			white: "#E5E9F0",
			brightBlack: "#4C566A",
			brightRed: "#BF616A",
			brightGreen: "#A3BE8C",
			brightYellow: "#EBCB8B",
			brightBlue: "#81A1C1",
			brightMagenta: "#B48EAD",
			brightCyan: "#8FBCBB",
			brightWhite: "#ECEFF4",
		},
	},

	solarizedDark: {
		name: "solarizedDark",
		displayName: "Solarized Dark",
		ui: {
			bgPrimary: "#002B36",
			bgSecondary: "#00212B",
			bgTertiary: "#073642",
			fgPrimary: "#839496",
			fgSecondary: "#586E75",
			accent: "#268BD2",
			accentHover: "#2AA198",
			border: "#073642",
			error: "#DC322F",
			warning: "#B58900",
			success: "#859900",
		},
		terminal: {
			background: "#002B36",
			foreground: "#839496",
			cursor: "#839496",
			selectionBackground: "#073642",
			black: "#073642",
			red: "#DC322F",
			green: "#859900",
			yellow: "#B58900",
			blue: "#268BD2",
			magenta: "#D33682",
			cyan: "#2AA198",
			white: "#EEE8D5",
			brightBlack: "#002B36",
			brightRed: "#CB4B16",
			brightGreen: "#586E75",
			brightYellow: "#657B83",
			brightBlue: "#839496",
			brightMagenta: "#6C71C4",
			brightCyan: "#93A1A1",
			brightWhite: "#FDF6E3",
		},
	},

	kanagawa: {
		name: "kanagawa",
		displayName: "Kanagawa",
		ui: {
			bgPrimary: "#1F1F28",
			bgSecondary: "#16161D",
			bgTertiary: "#2A2A37",
			fgPrimary: "#DCD7BA",
			fgSecondary: "#727169",
			accent: "#7E9CD8",
			accentHover: "#7FB4CA",
			border: "#363646",
			error: "#E82424",
			warning: "#FF9E3B",
			success: "#76946A",
		},
		terminal: {
			background: "#1F1F28",
			foreground: "#DCD7BA",
			cursor: "#C8C093",
			selectionBackground: "#2D4F67",
			black: "#090618",
			red: "#C34043",
			green: "#76946A",
			yellow: "#C0A36E",
			blue: "#7E9CD8",
			magenta: "#957FB8",
			cyan: "#6A9589",
			white: "#C8C093",
			brightBlack: "#727169",
			brightRed: "#E82424",
			brightGreen: "#98BB6C",
			brightYellow: "#E6C384",
			brightBlue: "#7FB4CA",
			brightMagenta: "#938AA9",
			brightCyan: "#7AA89F",
			brightWhite: "#DCD7BA",
		},
	},

	rosePine: {
		name: "rosePine",
		displayName: "Rosé Pine",
		ui: {
			bgPrimary: "#191724",
			bgSecondary: "#1F1D2E",
			bgTertiary: "#26233A",
			fgPrimary: "#E0DEF4",
			fgSecondary: "#6E6A86",
			accent: "#C4A7E7",
			accentHover: "#EBBCBA",
			border: "#403D52",
			error: "#EB6F92",
			warning: "#F6C177",
			success: "#31748F",
		},
		terminal: {
			background: "#191724",
			foreground: "#E0DEF4",
			cursor: "#524F67",
			selectionBackground: "#403D52",
			black: "#26233A",
			red: "#EB6F92",
			green: "#31748F",
			yellow: "#F6C177",
			blue: "#9CCFD8",
			magenta: "#C4A7E7",
			cyan: "#EBBCBA",
			white: "#E0DEF4",
			brightBlack: "#6E6A86",
			brightRed: "#EB6F92",
			brightGreen: "#31748F",
			brightYellow: "#F6C177",
			brightBlue: "#9CCFD8",
			brightMagenta: "#C4A7E7",
			brightCyan: "#EBBCBA",
			brightWhite: "#E0DEF4",
		},
	},

	moonlight: {
		name: "moonlight",
		displayName: "Moonlight",
		ui: {
			bgPrimary: "#222436",
			bgSecondary: "#1B1D2B",
			bgTertiary: "#2F334D",
			fgPrimary: "#C8D3F5",
			fgSecondary: "#636DA6",
			accent: "#82AAFF",
			accentHover: "#C3E88D",
			border: "#444A73",
			error: "#FF757F",
			warning: "#FFC777",
			success: "#C3E88D",
		},
		terminal: {
			background: "#222436",
			foreground: "#C8D3F5",
			cursor: "#C8D3F5",
			selectionBackground: "#2F334D",
			black: "#1B1D2B",
			red: "#FF757F",
			green: "#C3E88D",
			yellow: "#FFC777",
			blue: "#82AAFF",
			magenta: "#FCA7EA",
			cyan: "#86E1FC",
			white: "#C8D3F5",
			brightBlack: "#444A73",
			brightRed: "#FF757F",
			brightGreen: "#C3E88D",
			brightYellow: "#FFC777",
			brightBlue: "#82AAFF",
			brightMagenta: "#FCA7EA",
			brightCyan: "#86E1FC",
			brightWhite: "#D8DEE9",
		},
	},

	vesper: {
		name: "vesper",
		displayName: "Vesper",
		ui: {
			bgPrimary: "#101010",
			bgSecondary: "#0A0A0A",
			bgTertiary: "#1C1C1C",
			fgPrimary: "#D2D2D2",
			fgSecondary: "#7B7B7B",
			accent: "#FFC799",
			accentHover: "#FFD6B3",
			border: "#2A2A2A",
			error: "#F5A191",
			warning: "#FFC799",
			success: "#90B99F",
		},
		terminal: {
			background: "#101010",
			foreground: "#D2D2D2",
			cursor: "#FFC799",
			selectionBackground: "#2A2A2A",
			black: "#1C1C1C",
			red: "#F5A191",
			green: "#90B99F",
			yellow: "#E6B99D",
			blue: "#ACA1CF",
			magenta: "#E29ECA",
			cyan: "#9ACDCE",
			white: "#D2D2D2",
			brightBlack: "#7B7B7B",
			brightRed: "#F5A191",
			brightGreen: "#90B99F",
			brightYellow: "#FFC799",
			brightBlue: "#ACA1CF",
			brightMagenta: "#E29ECA",
			brightCyan: "#9ACDCE",
			brightWhite: "#EFEFEF",
		},
	},
};

export function applyTheme(theme: AppTheme) {
	const root = document.documentElement;
	root.style.setProperty("--bg-primary", theme.ui.bgPrimary);
	root.style.setProperty("--bg-secondary", theme.ui.bgSecondary);
	root.style.setProperty("--bg-tertiary", theme.ui.bgTertiary);
	root.style.setProperty("--fg-primary", theme.ui.fgPrimary);
	root.style.setProperty("--fg-secondary", theme.ui.fgSecondary);
	root.style.setProperty("--accent", theme.ui.accent);
	root.style.setProperty("--accent-hover", theme.ui.accentHover);
	root.style.setProperty("--border", theme.ui.border);
	root.style.setProperty("--error", theme.ui.error);
	root.style.setProperty("--warning", theme.ui.warning);
	root.style.setProperty("--success", theme.ui.success);

	// Re-define the Monaco editor theme with the new CSS variable values
	if (_monaco) {
		defineAbundioTheme(_monaco);
		_monaco.editor.setTheme("abundio");
	}
}

export function getTheme(name: string): AppTheme {
	return themes[name] ?? themes.default;
}

export function themeList(): AppTheme[] {
	return Object.values(themes);
}
