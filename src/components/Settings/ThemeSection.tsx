import { useMemo } from "react";
import { themeList } from "../../lib/themes";
import { useSettingsStore } from "../../stores/settingsStore";
import { SectionLabel, ToggleRow } from "./primitives";
import { ThemeCard } from "./ThemeCard";

export function ThemeSection() {
	const currentTheme = useSettingsStore((s) => s.theme);
	const setTheme = useSettingsStore((s) => s.setTheme);
	const focusSweep = useSettingsStore((s) => s.focusSweep);
	const setFocusSweep = useSettingsStore((s) => s.setFocusSweep);

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
			<div>
				<SectionLabel>Focus Sweep</SectionLabel>
				<ToggleRow
					checked={focusSweep}
					onChange={setFocusSweep}
					label="Sweep the border of a pane when it gains focus"
					description="In a tab with more than one pane, a short accent-coloured arc runs once around the pane that gains focus, so you can see where focus landed. With reduced motion turned on in your system settings, the border lights up and fades instead."
				/>
			</div>
		</div>
	);
}
