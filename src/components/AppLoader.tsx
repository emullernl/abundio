import { useEffect, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";

export function AppLoader() {
	const initialized = useSessionStore((s) => s.sessionsInitialized);
	const [visible, setVisible] = useState(true);

	useEffect(() => {
		if (!initialized) return;
		// Fade out, then unmount
		const timer = setTimeout(() => setVisible(false), 200);
		return () => clearTimeout(timer);
	}, [initialized]);

	if (!visible) return null;

	return (
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center"
			style={{
				backgroundColor: "var(--bg-primary)",
				opacity: initialized ? 0 : 1,
				transition: "opacity 200ms ease-out",
			}}
		>
			<div className="flex flex-col items-center gap-4">
				<div
					style={{
						color: "var(--accent)",
						fontSize: 24,
						fontWeight: 500,
					}}
				>
					Abundio
				</div>
				<div className="flex gap-[3px]">
					{[0, 1, 2, 3, 4].map((i) => (
						<div
							key={i}
							style={{
								width: 3,
								height: 14,
								borderRadius: 1,
								backgroundColor: "var(--accent)",
								opacity: 0.15,
								animation: `terminal-bar-wave 1.2s ease-in-out ${i * 0.12}s infinite`,
							}}
						/>
					))}
				</div>
				<span
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 10,
						color: "var(--fg-secondary)",
						opacity: 0.4,
						letterSpacing: "0.08em",
						textTransform: "uppercase",
					}}
				>
					loading
				</span>
			</div>
		</div>
	);
}
