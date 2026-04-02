export interface FontEntry {
	/** CSS font-family value including fallback, e.g. "'FiraCode Nerd Font Mono', monospace" */
	name: string;
	/** Human-readable label, e.g. "Fira Code" */
	displayName: string;
}

/** Terminal fonts bundled with Abundio — guaranteed to work out of the box */
export const TERMINAL_FONTS: FontEntry[] = [
	{ name: "'JetBrainsMonoNL Nerd Font Mono', monospace", displayName: "JetBrains Mono NL" },
	{ name: "'FiraCode Nerd Font Mono', monospace", displayName: "Fira Code" },
	{ name: "'CaskaydiaCove Nerd Font Mono', monospace", displayName: "Cascadia Code" },
	{ name: "'Hack Nerd Font Mono', monospace", displayName: "Hack" },
	{ name: "'MesloLGS Nerd Font Mono', monospace", displayName: "Meslo LGS" },
	{ name: "'SauceCodePro Nerd Font Mono', monospace", displayName: "Source Code Pro" },
	{ name: "'VictorMono Nerd Font Mono', monospace", displayName: "Victor Mono" },
	{ name: "'GeistMono Nerd Font Mono', monospace", displayName: "Geist Mono" },
	{ name: "'UbuntuMono Nerd Font Mono', monospace", displayName: "Ubuntu Mono" },
	{ name: "'Inconsolata Nerd Font Mono', monospace", displayName: "Inconsolata" },
];

/** Convert a raw system font family name to a FontEntry */
export function systemFontToEntry(family: string): FontEntry {
	return {
		name: `'${family}', system-ui, sans-serif`,
		displayName: family,
	};
}
