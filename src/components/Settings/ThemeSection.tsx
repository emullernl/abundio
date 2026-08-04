import { useMemo } from "react";
import { themeList } from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";
import { SectionLabel } from "./primitives";
import { ThemeCard } from "./ThemeCard";

export function ThemeSection() {
	const currentTheme = useSettingsStore((s) => s.theme);
	const setTheme = useSettingsStore((s) => s.setTheme);

	const darkThemes = useMemo(
		() => themeList().filter((t) => t.variant === "dark"),
		[],
	);
	const lightThemes = useMemo(
		() => themeList().filter((t) => t.variant === "light"),
		[],
	);

	return (
		<div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5">
			<div>
				<SectionLabel>Dark</SectionLabel>
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: "repeat(2, 1fr)" }}
				>
					{darkThemes.map((theme) => (
						<ThemeCard
							key={theme.name}
							theme={theme}
							isActive={theme.name === currentTheme}
							onSelect={() => setTheme(theme.name)}
						/>
					))}
				</div>
			</div>
			<div>
				<SectionLabel>Light</SectionLabel>
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: "repeat(2, 1fr)" }}
				>
					{lightThemes.map((theme) => (
						<ThemeCard
							key={theme.name}
							theme={theme}
							isActive={theme.name === currentTheme}
							onSelect={() => setTheme(theme.name)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
