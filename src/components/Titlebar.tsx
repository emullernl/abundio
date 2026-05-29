import { isMac } from "../lib/platform";
import { profileQualifiedTitle, useProfileStore } from "../stores/profileStore";

interface Props {
	/** Optional override. When set, the chrome shows this string verbatim
	 *  instead of deriving from the window's active profile. Used by the
	 *  Settings window, which is global and has no profile of its own. */
	title?: string;
}

/**
 * Drag region for macOS titleBarStyle: "Overlay". The native traffic lights
 * sit on top of this area on the left; we render the window's profile-aware
 * title text centered so the user can see "Abundio - <Profile> profile"
 * even though the OS title is suppressed (hiddenTitle: true).
 *
 * Positioned absolutely so it doesn't affect layout flow.
 */
export function Titlebar({ title: titleOverride }: Props = {}) {
	const activeProfileName = useProfileStore((s) => {
		const active = s.profiles.find((p) => p.id === s.activeProfileId);
		return active?.name ?? null;
	});

	if (!isMac) return null;

	const title =
		titleOverride ??
		(activeProfileName ? profileQualifiedTitle(activeProfileName) : "Abundio");

	return (
		<div
			data-tauri-drag-region
			className="fixed top-0 left-0 right-0 z-50 select-none"
			style={{
				// Full-width strip behind the traffic lights so the buttons
				// no longer bleed through onto the content beneath when the
				// sidebar is collapsed. Background matches the sidebar.
				height: 28,
				backgroundColor: "var(--bg-secondary)",
				borderBottom: "1px solid var(--border)",
			}}
		>
			{/* Title text aligned left, right of the traffic-light buttons.
			    The native lights occupy roughly the first 70px (12px inset
			    + ~52px button cluster); 84px gives a comfortable gap. */}
			<span
				data-tauri-drag-region
				style={{
					position: "absolute",
					top: "50%",
					left: 84,
					transform: "translateY(-50%)",
					fontSize: 13,
					fontWeight: 500,
					color: "var(--fg-secondary)",
					letterSpacing: "0.01em",
					pointerEvents: "none",
					whiteSpace: "nowrap",
				}}
			>
				{title}
			</span>
		</div>
	);
}
