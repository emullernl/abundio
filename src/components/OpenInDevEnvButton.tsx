import { useCallback, useEffect, useRef, useState } from "react";
import { pickActiveDevEnvId } from "../lib/devEnvironments";
import { devEnvironments as devEnvApi } from "../lib/ipc";
import type { DetectedDevEnvironment, LaunchFile } from "../lib/types";
import { useDevEnvironmentsStore } from "../stores/devEnvironmentsStore";
import { useSettingsStore } from "../stores/settingsStore";

interface Props {
	workspaceFolder: string;
	activeFilePath: string | null;
}

export function OpenInDevEnvButton({ workspaceFolder, activeFilePath }: Props) {
	const installed = useDevEnvironmentsStore((s) => s.installed);
	const loaded = useDevEnvironmentsStore((s) => s.loaded);
	const lastOpenedDevEnvId = useSettingsStore((s) => s.lastOpenedDevEnvId);
	const setLastOpenedDevEnvId = useSettingsStore(
		(s) => s.setLastOpenedDevEnvId,
	);
	const [menuOpen, setMenuOpen] = useState(false);
	const [hoverPrimary, setHoverPrimary] = useState(false);
	const [hoverCaret, setHoverCaret] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const activeId = pickActiveDevEnvId(installed, lastOpenedDevEnvId);
	const activeEnv = installed.find((e) => e.id === activeId) ?? null;
	const noInstalled = installed.length === 0;
	const disabled = !activeEnv;

	const launch = useCallback(
		async (env: DetectedDevEnvironment) => {
			const file: LaunchFile | null = activeFilePath
				? { path: activeFilePath }
				: null;
			try {
				await devEnvApi.launch(env.id, workspaceFolder, file);
				setLastOpenedDevEnvId(env.id);
			} catch (err) {
				console.error("Failed to launch dev environment:", err);
			}
		},
		[workspaceFolder, activeFilePath, setLastOpenedDevEnvId],
	);

	const handlePrimaryClick = useCallback(() => {
		if (!activeEnv) return;
		void launch(activeEnv);
	}, [activeEnv, launch]);

	const handleEnvPick = useCallback(
		(env: DetectedDevEnvironment) => {
			setMenuOpen(false);
			void launch(env);
		},
		[launch],
	);

	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				menuRef.current &&
				!menuRef.current.contains(target) &&
				containerRef.current &&
				!containerRef.current.contains(target)
			) {
				setMenuOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [menuOpen]);

	if (!loaded) return null;

	const label = activeEnv?.displayName ?? "No editor";
	const borderColor = menuOpen ? "var(--accent)" : "var(--border)";
	const containerBg = menuOpen
		? "var(--bg-secondary)"
		: "color-mix(in srgb, var(--bg-secondary) 35%, transparent)";

	return (
		<div
			ref={containerRef}
			className="relative shrink-0"
			style={{ alignSelf: "center", marginBottom: 4 }}
		>
			<div
				className="flex items-center"
				style={{
					height: 26,
					borderRadius: 6,
					border: `1px solid ${borderColor}`,
					backgroundColor: disabled ? "transparent" : containerBg,
					opacity: noInstalled ? 0.45 : 1,
					transition:
						"background-color 140ms ease-out, border-color 140ms ease-out, opacity 140ms ease-out",
					overflow: "hidden",
				}}
			>
				<button
					type="button"
					onClick={handlePrimaryClick}
					disabled={disabled}
					onMouseEnter={() => setHoverPrimary(true)}
					onMouseLeave={() => setHoverPrimary(false)}
					title={
						activeEnv
							? `Open in ${activeEnv.displayName}${
									activeFilePath ? " — workspace + active file" : ""
								}`
							: "No dev environment detected"
					}
					className="flex items-center"
					style={{
						height: "100%",
						paddingLeft: 10,
						paddingRight: 8,
						gap: 7,
						color: hoverPrimary ? "var(--fg-primary)" : "var(--fg-secondary)",
						cursor: disabled ? "not-allowed" : "pointer",
						fontFamily: "var(--font-mono)",
						fontSize: 11.5,
						letterSpacing: "0.015em",
						backgroundColor: hoverPrimary
							? "color-mix(in srgb, var(--bg-tertiary) 55%, transparent)"
							: "transparent",
						border: "none",
						transition: "background-color 120ms ease-out, color 120ms ease-out",
					}}
				>
					<BrandIcon
						iconName={activeEnv?.iconName ?? "generic"}
						size={14}
						muted={disabled}
					/>
					<span
						style={{
							maxWidth: 110,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{label}
					</span>
				</button>

				<div
					aria-hidden
					style={{
						width: 1,
						height: 14,
						backgroundColor: "var(--border)",
						opacity: 0.75,
						flexShrink: 0,
					}}
				/>

				<button
					type="button"
					onClick={() => {
						if (noInstalled) return;
						setMenuOpen((v) => !v);
					}}
					disabled={noInstalled}
					onMouseEnter={() => setHoverCaret(true)}
					onMouseLeave={() => setHoverCaret(false)}
					title="Choose dev environment"
					aria-label="Choose dev environment"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					className="flex items-center justify-center"
					style={{
						height: "100%",
						width: 20,
						color:
							hoverCaret || menuOpen
								? "var(--fg-primary)"
								: "var(--fg-secondary)",
						cursor: noInstalled ? "not-allowed" : "pointer",
						backgroundColor:
							hoverCaret || menuOpen
								? "color-mix(in srgb, var(--bg-tertiary) 55%, transparent)"
								: "transparent",
						border: "none",
						transition: "background-color 120ms ease-out, color 120ms ease-out",
					}}
				>
					<ChevronGlyph size={9} flipped={menuOpen} />
				</button>
			</div>

			{menuOpen && (
				<div
					ref={menuRef}
					role="menu"
					className="absolute z-[300]"
					style={{
						top: "calc(100% + 6px)",
						right: 0,
						minWidth: 240,
						maxHeight: 380,
						overflowY: "auto",
						padding: 5,
						borderRadius: 10,
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						boxShadow:
							"0 16px 48px rgba(0, 0, 0, 0.32), 0 2px 8px rgba(0, 0, 0, 0.16)",
					}}
				>
					<div
						style={{
							fontFamily: "var(--font-ui)",
							fontSize: 9.5,
							letterSpacing: "0.09em",
							textTransform: "uppercase",
							color: "var(--fg-secondary)",
							padding: "6px 10px 8px",
							opacity: 0.7,
						}}
					>
						Open workspace in
					</div>
					{installed.map((env) => (
						<DevEnvMenuItem
							key={env.id}
							env={env}
							isActive={env.id === activeEnv?.id}
							onClick={() => handleEnvPick(env)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function DevEnvMenuItem({
	env,
	isActive,
	onClick,
}: {
	env: DetectedDevEnvironment;
	isActive: boolean;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			className="flex items-center w-full"
			style={{
				height: 30,
				paddingLeft: 10,
				paddingRight: 8,
				gap: 10,
				fontFamily: "var(--font-mono)",
				fontSize: 11.5,
				letterSpacing: "0.015em",
				textAlign: "left",
				color: "var(--fg-primary)",
				backgroundColor: hovered ? "var(--bg-tertiary)" : "transparent",
				border: "none",
				borderRadius: 6,
				cursor: "pointer",
				transition: "background-color 100ms ease-out",
			}}
		>
			<BrandIcon iconName={env.iconName} size={14} />
			<span
				style={{
					flex: 1,
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
				}}
			>
				{env.displayName}
			</span>
			{isActive && (
				<>
					<span
						style={{
							fontFamily: "var(--font-ui)",
							fontSize: 9,
							letterSpacing: "0.08em",
							textTransform: "uppercase",
							color: "var(--fg-secondary)",
						}}
					>
						default
					</span>
					<span
						aria-hidden
						style={{
							width: 5,
							height: 5,
							borderRadius: "50%",
							backgroundColor: "var(--accent)",
							flexShrink: 0,
						}}
					/>
				</>
			)}
		</button>
	);
}

// ───────────────────────────────── Icons ─────────────────────────────────
// Per-brand SVGs. Geometric interpretations that read cleanly at 14px and carry
// each product's primary brand color. JetBrains products all share one mark
// (the backend maps every JB IDE to icon_name "jetbrains").

interface IconProps {
	size?: number;
	muted?: boolean;
}

function BrandIcon({
	iconName,
	size = 14,
	muted = false,
}: IconProps & { iconName: string }) {
	const opacity = muted ? 0.45 : 1;
	switch (iconName) {
		case "vscode":
			return <VSCodeIcon size={size} opacity={opacity} color="#0098FF" />;
		case "vscode-insiders":
			return <VSCodeIcon size={size} opacity={opacity} color="#24BFA5" />;
		case "cursor":
			return <CursorIcon size={size} opacity={opacity} />;
		case "windsurf":
			return <WindsurfIcon size={size} opacity={opacity} />;
		case "zed":
			return <ZedIcon size={size} opacity={opacity} />;
		case "sublime":
			return <SublimeIcon size={size} opacity={opacity} />;
		case "xcode":
			return <XcodeIcon size={size} opacity={opacity} />;
		case "jetbrains":
			return <JetBrainsIcon size={size} opacity={opacity} />;
		default:
			return <GenericIcon size={size} opacity={opacity} />;
	}
}

function VSCodeIcon({
	size,
	opacity,
	color,
}: {
	size: number;
	opacity: number;
	color: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<path
				fill={color}
				d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zM18.004 17.448L10.826 12l7.178-5.448v10.896z"
			/>
		</svg>
	);
}

function CursorIcon({ size, opacity }: { size: number; opacity: number }) {
	// Stylized three-facet prism evoking Cursor's triangular mark.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<path
				d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.31L19.06 8.4 12 12.48 4.94 8.4 12 4.31zM4 9.82l7 4.05v7.31L4 17.13V9.82zm16 0v7.31l-7 4.05v-7.31l7-4.05z"
				fill="currentColor"
			/>
		</svg>
	);
}

function WindsurfIcon({ size, opacity }: { size: number; opacity: number }) {
	// Concentric curves — wave/wind motif.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<g fill="none" stroke="#09B6A2" strokeLinecap="round">
				<path d="M3 9 C7 5 11 5 15 9 C18 12 20 12 22 10" strokeWidth="2.4" />
				<path
					d="M3 15 C7 11 11 11 15 15 C18 18 20 18 22 16"
					strokeWidth="2.4"
					opacity="0.55"
				/>
			</g>
		</svg>
	);
}

function ZedIcon({ size, opacity }: { size: number; opacity: number }) {
	// Angular "Z" inside a rounded square.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<rect x="2" y="2" width="20" height="20" rx="4.5" fill="#0B40E0" />
			<path
				d="M7.5 7.5h9l-7 9h7"
				fill="none"
				stroke="#FFFFFF"
				strokeWidth="2.1"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function SublimeIcon({ size, opacity }: { size: number; opacity: number }) {
	// Two stacked parallelograms in Sublime's orange gradient motif.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<path d="M4 6.6 L20 3 L20 9.4 L4 13 Z" fill="#FF9800" />
			<path d="M4 14.6 L20 11 L20 17.4 L4 21 Z" fill="#FF9800" opacity="0.55" />
		</svg>
	);
}

function XcodeIcon({ size, opacity }: { size: number; opacity: number }) {
	// Stylized hammer / chisel angle evoking Xcode's mark.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<rect x="2" y="2" width="20" height="20" rx="4.5" fill="#147EFB" />
			<path
				d="M7 16.5 L12 7.5 L17 16.5 M9 13.5 H15"
				fill="none"
				stroke="#FFFFFF"
				strokeWidth="2.1"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function JetBrainsIcon({ size, opacity }: { size: number; opacity: number }) {
	// Toolbox-style 2x2 grid of brand colors. Each JB product shares this mark.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<rect x="2" y="2" width="9" height="9" rx="1.4" fill="#FF318C" />
			<rect x="13" y="2" width="9" height="9" rx="1.4" fill="#FCEE39" />
			<rect x="2" y="13" width="9" height="9" rx="1.4" fill="#21D789" />
			<rect x="13" y="13" width="9" height="9" rx="1.4" fill="#087CFA" />
		</svg>
	);
}

function GenericIcon({ size, opacity }: { size: number; opacity: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ opacity }}
			aria-hidden="true"
		>
			<path
				d="M9 6 L3 12 L9 18 M15 6 L21 12 L15 18"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function ChevronGlyph({ size, flipped }: { size: number; flipped: boolean }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 10 10"
			aria-hidden="true"
			style={{
				transform: flipped ? "rotate(180deg)" : undefined,
				transition: "transform 160ms ease-out",
			}}
		>
			<path
				d="M1.5 3.5 L5 7 L8.5 3.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
