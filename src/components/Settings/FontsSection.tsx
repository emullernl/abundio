import { useCallback, useEffect, useState } from "react";
import { fonts as fontsIpc } from "../../lib/ipc";
import {
	type FontEntry,
	SYSTEM_UI_FONT,
	systemFontToEntry,
	TERMINAL_FONTS,
} from "../../lib/nerdFonts";
import { setAllTerminalsFontSize } from "../../lib/terminalManager";
import { useSettingsStore } from "../../stores/settingsStore";
import { FontPicker } from "./FontPicker";
import { FontSizeControl } from "./NumberSteppers";
import { SectionLabel } from "./primitives";

/**
 * Cached at module scope, not in component state.
 *
 * `FontsSection` mounts and unmounts on every nav click, so a ref-guarded fetch
 * would re-enumerate every system font each time the user visits the page —
 * `font-kit`'s scan is the one IPC here that actually costs something. The
 * promise outlives the component; the font list cannot change while the app
 * runs, so there is nothing to invalidate.
 */
let systemFontsPromise: Promise<string[]> | null = null;
function loadSystemFonts(): Promise<string[]> {
	systemFontsPromise ??= fontsIpc.listSystemFonts().catch((err) => {
		systemFontsPromise = null; // let a later visit retry
		throw err;
	});
	return systemFontsPromise;
}

/**
 * Both typefaces on one page.
 *
 * Interface and terminal font are chosen relative to each other, so they belong
 * side by side; the Terminal page stays about PTY and rendering behaviour, not
 * about looks.
 */
export function FontsSection() {
	const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
	const setUiFontFamily = useSettingsStore((s) => s.setUiFontFamily);
	const uiFontSize = useSettingsStore((s) => s.uiFontSize);
	const setUiFontSize = useSettingsStore((s) => s.setUiFontSize);
	const terminalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
	const setTerminalFontFamily = useSettingsStore(
		(s) => s.setTerminalFontFamily,
	);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const setFontSize = useSettingsStore((s) => s.setFontSize);

	const [systemFonts, setSystemFonts] = useState<FontEntry[]>([SYSTEM_UI_FONT]);
	useEffect(() => {
		let cancelled = false;
		loadSystemFonts()
			.then((families) => {
				if (cancelled) return;
				const sorted = families.slice().sort((a, b) => a.localeCompare(b));
				// The shipped default heads the list: it is what a fresh install
				// uses, and it is not a family `font-kit` can enumerate.
				setSystemFonts([SYSTEM_UI_FONT, ...sorted.map(systemFontToEntry)]);
			})
			.catch(() => {
				if (!cancelled) setSystemFonts([SYSTEM_UI_FONT]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// The one cross-page coupling: terminal font size lives here, but its effect
	// targets the terminals. Existing panes are resized live.
	const handleTerminalFontSizeChange = useCallback(
		(size: number) => {
			setFontSize(size);
			setAllTerminalsFontSize(size);
		},
		[setFontSize],
	);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
			<div className="flex-shrink-0">
				<SectionLabel>Interface Font Size</SectionLabel>
				<FontSizeControl value={uiFontSize} onChange={setUiFontSize} />
			</div>
			<div className="flex flex-col flex-shrink-0" style={{ height: 220 }}>
				<SectionLabel>Interface Font</SectionLabel>
				<FontPicker
					fonts={systemFonts}
					selectedFont={uiFontFamily}
					onSelect={setUiFontFamily}
					searchPlaceholder="Search UI fonts..."
					previewStyle="ui"
				/>
			</div>
			<div
				className="flex-shrink-0"
				style={{
					borderTop: "1px solid var(--border)",
					marginTop: 2,
					paddingTop: 14,
				}}
			>
				<SectionLabel>Terminal Font Size</SectionLabel>
				<FontSizeControl
					value={fontSize}
					onChange={handleTerminalFontSizeChange}
				/>
			</div>
			<div
				className="flex flex-col flex-1"
				style={{ minHeight: 220, paddingBottom: 4 }}
			>
				<SectionLabel>Terminal Font</SectionLabel>
				<FontPicker
					fonts={TERMINAL_FONTS}
					selectedFont={terminalFontFamily}
					onSelect={setTerminalFontFamily}
					searchPlaceholder="Search nerd fonts..."
					previewStyle="mono"
				/>
			</div>
		</div>
	);
}
