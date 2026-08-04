import { useCallback, useEffect, useRef, useState } from "react";
import { fonts as fontsIpc } from "../lib/ipc";
import {
	type FontEntry,
	systemFontToEntry,
	TERMINAL_FONTS,
} from "../lib/nerdFonts";
import { setAllTerminalsFontSize } from "../lib/terminalManager";
import { useSettingsStore } from "../stores/settingsStore";
import { consumeRequestedSection } from "../stores/settingsUiStore";
import { AgentsSection } from "./Settings/AgentsSection";
import { FontPicker } from "./Settings/FontPicker";
import { GithubSection } from "./Settings/GithubSection";
import {
	AgentIcon,
	LayoutIcon,
	PaletteIcon,
	PrIcon,
	ProfileIcon,
	TerminalIcon,
	TypeIcon,
	UpdateIcon,
} from "./Settings/icons";
import { FontSizeControl, ScrollbackControl } from "./Settings/NumberSteppers";
import { ProfilesSection } from "./Settings/ProfilesSection";
import { NavItem, SectionLabel, ToggleRow } from "./Settings/primitives";
import { ShellPicker } from "./Settings/ShellPicker";
import { ThemeSection } from "./Settings/ThemeSection";
import { UpdatesSection } from "./Settings/UpdatesSection";

type Section =
	| "theme"
	| "terminal-font"
	| "ui-font"
	| "shell"
	| "agents"
	| "profiles"
	| "updates"
	| "github";

interface Props {
	/** Called when the user clicks the panel's X button. The settings window
	 *  itself handles all closes (Cmd+W, traffic-light X) — this prop is for
	 *  the explicit in-panel close affordance. */
	onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
	const [section, setSection] = useState<Section>("theme");

	// Honor "Manage Profiles…" / File menu deep-links by landing on the right
	// section when the panel opens.
	useEffect(() => {
		const requested = consumeRequestedSection();
		if (requested) setSection(requested as Section);
		// Listen for `settings-set-section` events from Rust — fired by
		// open_or_focus_settings_window when the user clicks "Manage Profiles…"
		// and the settings window is already open.
		const unlisten = import("@tauri-apps/api/event").then(({ listen }) =>
			listen<string>("settings-set-section", (event) => {
				const s = event.payload;
				if (
					s === "theme" ||
					s === "terminal-font" ||
					s === "ui-font" ||
					s === "shell" ||
					s === "agents" ||
					s === "profiles" ||
					s === "updates" ||
					s === "github"
				) {
					setSection(s);
				}
			}),
		);
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
	}, []);

	const terminalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
	const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
	const setTerminalFontFamily = useSettingsStore(
		(s) => s.setTerminalFontFamily,
	);
	const setUiFontFamily = useSettingsStore((s) => s.setUiFontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const setFontSize = useSettingsStore((s) => s.setFontSize);
	const terminalScrollback = useSettingsStore((s) => s.terminalScrollback);
	const setTerminalScrollback = useSettingsStore(
		(s) => s.setTerminalScrollback,
	);
	const uiFontSize = useSettingsStore((s) => s.uiFontSize);
	const setUiFontSize = useSettingsStore((s) => s.setUiFontSize);
	const gpuAccelerationEnabled = useSettingsStore(
		(s) => s.gpuAccelerationEnabled,
	);
	const setGpuAcceleration = useSettingsStore((s) => s.setGpuAcceleration);
	const smartImageDrop = useSettingsStore((s) => s.smartImageDrop);
	const setSmartImageDrop = useSettingsStore((s) => s.setSmartImageDrop);

	const [systemFonts, setSystemFonts] = useState<FontEntry[]>([]);
	const systemFontsLoaded = useRef(false);
	useEffect(() => {
		if (systemFontsLoaded.current) return;
		fontsIpc
			.listSystemFonts()
			.then((families) => {
				const sorted = families.slice().sort((a, b) => a.localeCompare(b));
				setSystemFonts(sorted.map(systemFontToEntry));
				systemFontsLoaded.current = true;
			})
			.catch(() => {
				setSystemFonts([]);
			});
	}, []);

	useEffect(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", handleEscape, true);
		return () => document.removeEventListener("keydown", handleEscape, true);
	}, [onClose]);

	const handleTerminalFontSizeChange = useCallback(
		(size: number) => {
			setFontSize(size);
			setAllTerminalsFontSize(size);
		},
		[setFontSize],
	);

	const handleUiFontSizeChange = useCallback(
		(size: number) => {
			setUiFontSize(size);
		},
		[setUiFontSize],
	);

	return (
		/* Renders as the entire content of the dedicated Settings window
		   (label="settings"). No modal overlay — the OS window IS the frame. */
		<div
			role="dialog"
			aria-label="Settings"
			className="flex flex-col w-full h-full"
			style={{
				backgroundColor: "var(--bg-secondary)",
			}}
		>
			{/* Header */}
			<div
				className="flex items-center justify-between flex-shrink-0"
				style={{
					padding: "12px 16px 12px 20px",
					borderBottom: "1px solid var(--border)",
				}}
			>
				<span
					className="font-semibold"
					style={{ fontSize: 13, color: "var(--fg-primary)" }}
				>
					Settings
				</span>
				<div className="flex items-center gap-3">
					<span
						className="font-mono"
						style={{
							fontSize: 10,
							color: "var(--fg-secondary)",
							opacity: 0.5,
							padding: "2px 6px",
							borderRadius: 4,
							border: "1px solid var(--border)",
						}}
					>
						esc
					</span>
				</div>
			</div>

			{/* Body: sidebar + content */}
			<div className="flex flex-1 min-h-0">
				{/* Left nav */}
				<div
					className="flex flex-col gap-1 flex-shrink-0"
					style={{
						width: 160,
						padding: "12px 8px",
						borderRight: "1px solid var(--border)",
						backgroundColor:
							"color-mix(in srgb, var(--bg-primary) 50%, var(--bg-secondary))",
					}}
				>
					<NavItem
						label="Theme"
						icon={<PaletteIcon />}
						isActive={section === "theme"}
						onClick={() => setSection("theme")}
					/>
					<NavItem
						label="Terminal Font"
						icon={<TypeIcon />}
						isActive={section === "terminal-font"}
						onClick={() => setSection("terminal-font")}
					/>
					<NavItem
						label="UI Font"
						icon={<LayoutIcon />}
						isActive={section === "ui-font"}
						onClick={() => setSection("ui-font")}
					/>
					<NavItem
						label="Shell"
						icon={<TerminalIcon />}
						isActive={section === "shell"}
						onClick={() => setSection("shell")}
					/>
					<NavItem
						label="Agents"
						icon={<AgentIcon />}
						isActive={section === "agents"}
						onClick={() => setSection("agents")}
					/>
					<NavItem
						label="Profiles"
						icon={<ProfileIcon />}
						isActive={section === "profiles"}
						onClick={() => setSection("profiles")}
					/>
					<NavItem
						label="Updates"
						icon={<UpdateIcon />}
						isActive={section === "updates"}
						onClick={() => setSection("updates")}
					/>
					<NavItem
						label="GitHub"
						icon={<PrIcon />}
						isActive={section === "github"}
						onClick={() => setSection("github")}
					/>
				</div>

				{/* Right content */}
				<div className="flex-1 min-w-0 min-h-0 flex flex-col p-5 overflow-hidden">
					{section === "theme" && <ThemeSection />}

					{section === "terminal-font" && (
						<div className="flex flex-col gap-4 flex-1 min-h-0">
							<div className="flex-shrink-0">
								<SectionLabel>GPU Acceleration</SectionLabel>
								<ToggleRow
									checked={gpuAccelerationEnabled}
									onChange={setGpuAcceleration}
									label="Render terminals on the GPU"
									description="Smoother scrolling and faster paint on heavy output. When many panes are open at once, some fall back to CPU rendering automatically."
								/>
							</div>
							<div className="flex-shrink-0">
								<SectionLabel>Drag &amp; Drop</SectionLabel>
								<ToggleRow
									checked={smartImageDrop}
									onChange={setSmartImageDrop}
									label="Drop images to agents as images"
									description="When you drop an image onto a running agent, paste it via the clipboard so the agent recognises it — instead of inserting the file path. Other dropped files always insert their path."
								/>
							</div>
							<div className="flex-shrink-0">
								<SectionLabel>Scrollback Lines</SectionLabel>
								<ScrollbackControl
									value={terminalScrollback}
									onChange={setTerminalScrollback}
								/>
							</div>
							<div className="flex-shrink-0">
								<SectionLabel>Terminal Font Size</SectionLabel>
								<FontSizeControl
									value={fontSize}
									onChange={handleTerminalFontSizeChange}
								/>
							</div>
							<div className="flex flex-col flex-1 min-h-0">
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
					)}

					{section === "ui-font" && (
						<div className="flex flex-col gap-4 flex-1 min-h-0">
							<div className="flex-shrink-0">
								<SectionLabel>UI Font Size</SectionLabel>
								<FontSizeControl
									value={uiFontSize}
									onChange={handleUiFontSizeChange}
								/>
							</div>
							<div className="flex flex-col flex-1 min-h-0">
								<SectionLabel>Interface Font</SectionLabel>
								<FontPicker
									fonts={systemFonts}
									selectedFont={uiFontFamily}
									onSelect={setUiFontFamily}
									searchPlaceholder="Search UI fonts..."
									previewStyle="ui"
								/>
							</div>
						</div>
					)}

					{section === "shell" && (
						<div className="flex flex-col flex-1 min-h-0">
							<SectionLabel>Default Shell</SectionLabel>
							<p
								style={{
									fontSize: 12,
									color: "var(--fg-secondary)",
									marginBottom: 12,
									lineHeight: 1.5,
								}}
							>
								Choose the shell for new terminal panes. Existing panes are not
								affected.
							</p>
							<ShellPicker />
						</div>
					)}

					{section === "agents" && <AgentsSection />}

					{section === "profiles" && <ProfilesSection />}

					{section === "updates" && <UpdatesSection />}

					{section === "github" && <GithubSection />}
				</div>
			</div>
		</div>
	);
}
