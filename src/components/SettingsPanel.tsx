import { useEffect, useState } from "react";
import {
	initialSection,
	normalizeSection,
	SETTINGS_NAV,
	type SettingsSection,
} from "../lib/settingsSections";
import { AgentsSection } from "./Settings/AgentsSection";
import { EditorSection } from "./Settings/EditorSection";
import { FontsSection } from "./Settings/FontsSection";
import { GithubSection } from "./Settings/GithubSection";
import {
	AgentIcon,
	EditorIcon,
	PaletteIcon,
	PrIcon,
	ProfileIcon,
	TerminalIcon,
	TypeIcon,
	UpdateIcon,
} from "./Settings/icons";
import { ProfilesSection } from "./Settings/ProfilesSection";
import { NavGroupLabel, NavItem } from "./Settings/primitives";
import { TerminalSection } from "./Settings/TerminalSection";
import { ThemeSection } from "./Settings/ThemeSection";
import { UpdatesSection } from "./Settings/UpdatesSection";

interface Props {
	/** Called when the user clicks the panel's X button. The settings window
	 *  itself handles all closes (Cmd+W, traffic-light X) — this prop is for
	 *  the explicit in-panel close affordance. */
	onClose: () => void;
}

const SECTION_ICON: Record<SettingsSection, React.ReactNode> = {
	theme: <PaletteIcon />,
	fonts: <TypeIcon />,
	terminal: <TerminalIcon />,
	editor: <EditorIcon />,
	agents: <AgentIcon />,
	profiles: <ProfileIcon />,
	github: <PrIcon />,
	updates: <UpdateIcon />,
};

const SECTION_BODY: Record<SettingsSection, React.ReactNode> = {
	theme: <ThemeSection />,
	fonts: <FontsSection />,
	terminal: <TerminalSection />,
	editor: <EditorSection />,
	agents: <AgentsSection />,
	profiles: <ProfilesSection />,
	github: <GithubSection />,
	updates: <UpdatesSection />,
};

export function SettingsPanel({ onClose }: Props) {
	// Resolve the deep-linked section in a lazy initializer, not an effect: an
	// effect would paint the default page for a frame before snapping.
	const [section, setSection] = useState<SettingsSection>(() =>
		initialSection(window.location.search),
	);

	// Take-once semantics, literally: strip `section=` from the URL so a reload
	// (or Vite HMR) leaves the user where they navigated instead of snapping
	// back. `?settings` itself is decorative — main.tsx branches on the window
	// label, not the query string.
	useEffect(() => {
		const url = new URL(window.location.href);
		if (url.searchParams.has("section")) {
			url.searchParams.delete("section");
			window.history.replaceState(null, "", url.toString());
		}
	}, []);

	// The other half of the deep link: Rust emits `settings-set-section` instead
	// of rebuilding the URL when the Settings window is already open.
	useEffect(() => {
		const unlisten = import("@tauri-apps/api/event").then(({ listen }) =>
			listen<string>("settings-set-section", (event) => {
				const next = normalizeSection(event.payload);
				if (next) setSection(next);
			}),
		);
		return () => {
			unlisten.then((fn) => fn()).catch(() => {});
		};
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

			{/* Body: nav rail + content */}
			<div className="flex flex-1 min-h-0">
				{/* Left nav: group captions over leaf pages. Leaves keep their icon
				    at the same x as the captions, so the icon column stays a clean
				    vertical line and no extra indent is needed. */}
				<nav
					aria-label="Settings sections"
					className="flex flex-col flex-shrink-0 overflow-y-auto"
					style={{
						width: 160,
						padding: "6px 8px 12px",
						borderRight: "1px solid var(--border)",
						backgroundColor:
							"color-mix(in srgb, var(--bg-primary) 50%, var(--bg-secondary))",
					}}
				>
					{SETTINGS_NAV.map((group) => (
						<div key={group.caption} className="flex flex-col gap-1">
							<NavGroupLabel>{group.caption}</NavGroupLabel>
							{group.items.map((item) => (
								<NavItem
									key={item.id}
									label={item.label}
									icon={SECTION_ICON[item.id]}
									isActive={section === item.id}
									onClick={() => setSection(item.id)}
								/>
							))}
						</div>
					))}
				</nav>

				{/* Right content */}
				<div className="flex-1 min-w-0 min-h-0 flex flex-col p-5 overflow-hidden">
					{SECTION_BODY[section]}
				</div>
			</div>
		</div>
	);
}
