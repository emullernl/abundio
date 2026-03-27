import type { ITheme } from "@xterm/xterm";

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
}

export function getTheme(name: string): AppTheme {
	return themes[name] ?? themes.default;
}

export function themeList(): AppTheme[] {
	return Object.values(themes);
}
