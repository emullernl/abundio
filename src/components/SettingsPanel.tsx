import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fonts as fontsIpc, shells as shellsIpc } from "../lib/ipc";
import {
	type FontEntry,
	systemFontToEntry,
	TERMINAL_FONTS,
} from "../lib/nerdFonts";
import { setAllTerminalsFontSize } from "../lib/terminalManager";
import { type AppTheme, themeList } from "../lib/themes";
import type { AvailableShell, CodingAgent } from "../lib/types";
import { useAgentRegistryStore } from "../stores/agentRegistryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { Check, Plus, X } from "./Icons";

type Section = "theme" | "terminal-font" | "ui-font" | "shell" | "agents";

interface Props {
	open: boolean;
	onClose: () => void;
}

function fuzzyMatch(query: string, text: string): number {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (q.length === 0) return 1;
	if (t.includes(q)) return 2 + q.length / t.length;
	let qi = 0;
	let score = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += 1;
			qi++;
		}
	}
	return qi === q.length ? score / t.length : 0;
}

/* ─── Mini terminal preview for theme cards ─── */
function TerminalPreview({ theme }: { theme: AppTheme }) {
	const t = theme.terminal;
	const labels = ["drwx", "file", ".cfg", "app/", "test", "node"] as const;
	const colors = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan];
	return (
		<div
			className="rounded-md overflow-hidden"
			style={{
				backgroundColor: t.background,
				padding: "8px 10px",
				fontFamily: "var(--font-mono)",
				fontSize: 10,
				lineHeight: 1.5,
				letterSpacing: "0.02em",
			}}
		>
			<div style={{ color: t.green ?? "#3fb950" }}>
				<span style={{ color: t.cyan ?? "#58d5ba" }}>~</span>
				<span style={{ color: t.foreground, opacity: 0.5 }}> $ </span>
				<span style={{ color: t.foreground }}>ls -la</span>
			</div>
			<div className="flex gap-2 mt-0.5">
				{colors.map((c, i) => (
					<span key={labels[i]} style={{ color: c ?? "#888" }}>
						{labels[i]}
					</span>
				))}
			</div>
			<div style={{ color: t.foreground, opacity: 0.4, marginTop: 1 }}>
				<span style={{ color: t.cyan ?? "#58d5ba" }}>~</span>
				<span style={{ color: t.foreground, opacity: 0.5 }}> $ </span>
				<span
					style={{
						display: "inline-block",
						width: 6,
						height: 12,
						backgroundColor: t.cursor ?? t.foreground,
						verticalAlign: "middle",
						opacity: 0.8,
					}}
				/>
			</div>
		</div>
	);
}

/* ─── Theme card in a 2-col grid ─── */
function ThemeCard({
	theme,
	isActive,
	onSelect,
}: {
	theme: AppTheme;
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="text-left rounded-lg transition-all group"
			style={{
				padding: 2,
				background: isActive
					? `linear-gradient(135deg, ${theme.ui.accent}40, ${theme.ui.accent}15)`
					: "transparent",
				border: isActive
					? `1px solid ${theme.ui.accent}60`
					: "1px solid var(--border)",
				outline: isActive ? `1px solid ${theme.ui.accent}30` : "none",
				outlineOffset: 1,
			}}
		>
			<TerminalPreview theme={theme} />
			<div className="flex items-center justify-between px-2 py-1.5">
				<span
					className="text-xs font-medium"
					style={{
						color: isActive ? "var(--accent)" : "var(--fg-secondary)",
					}}
				>
					{theme.displayName}
				</span>
				{isActive && <Check size={12} />}
			</div>
		</button>
	);
}

/* ─── Section label ─── */
function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div
			className="font-semibold"
			style={{
				fontSize: 11,
				color: "var(--fg-secondary)",
				letterSpacing: "0.06em",
				textTransform: "uppercase",
				marginBottom: 10,
			}}
		>
			{children}
		</div>
	);
}

/* ─── Search input ─── */
function SearchInput({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder: string;
}) {
	return (
		<div className="relative">
			<svg
				aria-hidden="true"
				className="absolute top-1/2 -translate-y-1/2"
				style={{ left: 10, color: "var(--fg-secondary)", opacity: 0.5 }}
				width="13"
				height="13"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			>
				<circle cx="11" cy="11" r="8" />
				<path d="M21 21l-4.35-4.35" />
			</svg>
			<input
				type="text"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full bg-transparent outline-none rounded-md"
				style={{
					color: "var(--fg-primary)",
					fontSize: 12,
					padding: "7px 10px 7px 30px",
					border: "1px solid var(--border)",
					backgroundColor: "var(--bg-primary)",
				}}
			/>
		</div>
	);
}

/* ─── Font item row ─── */
function FontRow({
	font,
	isSelected,
	onSelect,
	previewStyle,
}: {
	font: FontEntry;
	isSelected: boolean;
	onSelect: () => void;
	previewStyle: "mono" | "ui";
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="w-full text-left rounded-md transition-all flex items-center gap-3 group"
			style={{
				padding: "8px 10px",
				backgroundColor: isSelected
					? "color-mix(in srgb, var(--accent) 10%, transparent)"
					: "transparent",
				borderLeft: isSelected
					? "2px solid var(--accent)"
					: "2px solid transparent",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className="truncate"
					style={{
						fontFamily: font.name,
						fontSize: previewStyle === "mono" ? 13 : 14,
						color: "var(--fg-primary)",
						lineHeight: 1.4,
					}}
				>
					ABCDEF abcdef 012345 !@#$%
				</div>
				<div
					className="mt-0.5"
					style={{
						fontSize: 10,
						color: isSelected ? "var(--accent)" : "var(--fg-secondary)",
						opacity: isSelected ? 1 : 0.7,
					}}
				>
					{font.displayName}
				</div>
			</div>
			{isSelected && (
				<div style={{ color: "var(--accent)", flexShrink: 0 }}>
					<Check size={14} />
				</div>
			)}
		</button>
	);
}

/* ─── Font picker section ─── */
function FontPicker({
	fonts,
	selectedFont,
	onSelect,
	searchPlaceholder,
	previewStyle,
}: {
	fonts: FontEntry[];
	selectedFont: string;
	onSelect: (name: string) => void;
	searchPlaceholder: string;
	previewStyle: "mono" | "ui";
}) {
	const [query, setQuery] = useState("");
	const listRef = useRef<HTMLDivElement>(null);

	const filtered = useMemo(() => {
		if (!query) return fonts;
		return fonts
			.map((f) => ({ font: f, score: fuzzyMatch(query, f.displayName) }))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score)
			.map(({ font }) => font);
	}, [fonts, query]);

	// Scroll selected into view once the font list is populated
	const hasScrolled = useRef(false);
	useEffect(() => {
		if (!listRef.current || filtered.length === 0 || hasScrolled.current)
			return;
		hasScrolled.current = true;
		const idx = filtered.findIndex((f) => f.name === selectedFont);
		if (idx > 0) {
			(
				listRef.current.children[idx] as HTMLElement | undefined
			)?.scrollIntoView({ block: "center" });
		}
	}, [filtered, selectedFont]);

	return (
		<div className="flex flex-col gap-2 flex-1 min-h-0">
			<SearchInput
				value={query}
				onChange={setQuery}
				placeholder={searchPlaceholder}
			/>
			<div
				ref={listRef}
				className="overflow-y-auto flex flex-col flex-1 min-h-0"
			>
				{filtered.length === 0 && (
					<div
						className="py-6 text-center"
						style={{ color: "var(--fg-secondary)", fontSize: 12 }}
					>
						No fonts match your search
					</div>
				)}
				{filtered.map((font) => (
					<FontRow
						key={font.name}
						font={font}
						isSelected={font.name === selectedFont}
						onSelect={() => onSelect(font.name)}
						previewStyle={previewStyle}
					/>
				))}
			</div>
		</div>
	);
}

/* ─── Font size control ─── */
function FontSizeControl({
	value,
	onChange,
}: {
	value: number;
	onChange: (size: number) => void;
}) {
	return (
		<div
			className="flex items-center gap-4 rounded-lg"
			style={{
				padding: "10px 14px",
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			<span
				className="flex-shrink-0"
				style={{ fontSize: 11, color: "var(--fg-secondary)" }}
			>
				Size
			</span>
			<input
				type="range"
				min={8}
				max={32}
				step={1}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="flex-1 accent-[var(--accent)]"
				style={{ height: 3 }}
			/>
			<div className="flex items-center gap-1 flex-shrink-0">
				<button
					type="button"
					onClick={() => onChange(Math.max(8, value - 1))}
					className="rounded flex items-center justify-center transition-colors"
					style={{
						width: 22,
						height: 22,
						color: "var(--fg-secondary)",
						backgroundColor: "var(--bg-tertiary)",
						fontSize: 14,
						lineHeight: 1,
					}}
				>
					-
				</button>
				<span
					className="font-mono text-center"
					style={{
						fontSize: 12,
						color: "var(--fg-primary)",
						width: 32,
					}}
				>
					{value}px
				</span>
				<button
					type="button"
					onClick={() => onChange(Math.min(32, value + 1))}
					className="rounded flex items-center justify-center transition-colors"
					style={{
						width: 22,
						height: 22,
						color: "var(--fg-secondary)",
						backgroundColor: "var(--bg-tertiary)",
						fontSize: 14,
						lineHeight: 1,
					}}
				>
					+
				</button>
			</div>
		</div>
	);
}

function ScrollbackControl({
	value,
	onChange,
}: {
	value: number;
	onChange: (n: number) => void;
}) {
	const MIN = 500;
	const MAX = 100000;
	const STEP = 500;
	const clamp = (n: number) => Math.min(MAX, Math.max(MIN, n));
	return (
		<div
			className="flex items-center gap-4 rounded-lg"
			style={{
				padding: "10px 14px",
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			<span
				className="flex-shrink-0"
				style={{ fontSize: 11, color: "var(--fg-secondary)" }}
			>
				Lines
			</span>
			<input
				type="range"
				min={MIN}
				max={MAX}
				step={STEP}
				value={value}
				onChange={(e) => onChange(clamp(Number(e.target.value)))}
				className="flex-1 accent-[var(--accent)]"
				style={{ height: 3 }}
			/>
			<div className="flex items-center gap-1 flex-shrink-0">
				<button
					type="button"
					onClick={() => onChange(clamp(value - STEP))}
					className="rounded flex items-center justify-center transition-colors"
					style={{
						width: 22,
						height: 22,
						color: "var(--fg-secondary)",
						backgroundColor: "var(--bg-tertiary)",
						fontSize: 14,
						lineHeight: 1,
					}}
				>
					-
				</button>
				<span
					className="font-mono text-center"
					style={{
						fontSize: 12,
						color: "var(--fg-primary)",
						width: 48,
					}}
				>
					{value.toLocaleString()}
				</span>
				<button
					type="button"
					onClick={() => onChange(clamp(value + STEP))}
					className="rounded flex items-center justify-center transition-colors"
					style={{
						width: 22,
						height: 22,
						color: "var(--fg-secondary)",
						backgroundColor: "var(--bg-tertiary)",
						fontSize: 14,
						lineHeight: 1,
					}}
				>
					+
				</button>
			</div>
		</div>
	);
}

/* ─── Nav item in the left sidebar ─── */
function NavItem({
	label,
	isActive,
	onClick,
	icon,
}: {
	label: string;
	isActive: boolean;
	onClick: () => void;
	icon: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full text-left flex items-center gap-2.5 rounded-md transition-all"
			style={{
				padding: "7px 10px",
				fontSize: 12,
				color: isActive ? "var(--fg-primary)" : "var(--fg-secondary)",
				backgroundColor: isActive ? "var(--bg-tertiary)" : "transparent",
			}}
		>
			<span style={{ opacity: isActive ? 1 : 0.5 }}>{icon}</span>
			{label}
		</button>
	);
}

/* ─── SVG icons for nav ─── */
function PaletteIcon() {
	return (
		<svg
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
			<circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
			<circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
			<circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
			<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
		</svg>
	);
}

function TypeIcon() {
	return (
		<svg
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="4 7 4 4 20 4 20 7" />
			<line x1="9" y1="20" x2="15" y2="20" />
			<line x1="12" y1="4" x2="12" y2="20" />
		</svg>
	);
}

function LayoutIcon() {
	return (
		<svg
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<path d="M3 9h18" />
			<path d="M9 21V9" />
		</svg>
	);
}

/* ─── Toggle switch ─── */
function Toggle({
	checked,
	onChange,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onChange(!checked)}
			className="relative flex-shrink-0 rounded-full transition-colors"
			style={{
				width: 32,
				height: 18,
				backgroundColor: checked ? "var(--accent)" : "var(--bg-tertiary)",
				border: `1px solid ${checked ? "transparent" : "var(--border)"}`,
			}}
		>
			<span
				className="absolute top-0.5 rounded-full transition-all"
				style={{
					width: 14,
					height: 14,
					left: checked ? 15 : 2,
					backgroundColor: checked
						? "var(--bg-primary)"
						: "var(--fg-secondary)",
				}}
			/>
		</button>
	);
}

/* ─── Agent row ─── */
function AgentRow({
	agent,
	installed,
	onToggle,
	onRemove,
}: {
	agent: CodingAgent;
	installed: boolean;
	onToggle: () => void;
	onRemove?: () => void;
}) {
	return (
		<div
			className="flex items-center gap-3 rounded-lg group transition-colors"
			style={{
				padding: "9px 10px",
				backgroundColor: agent.enabled
					? "transparent"
					: "color-mix(in srgb, var(--bg-tertiary) 40%, transparent)",
			}}
		>
			<Toggle checked={agent.enabled} onChange={onToggle} />
			<div
				className="flex-1 min-w-0"
				style={{
					opacity: agent.enabled ? 1 : 0.5,
				}}
			>
				<div
					className="truncate"
					style={{
						fontSize: 13,
						color: "var(--fg-primary)",
						lineHeight: 1.3,
					}}
				>
					{agent.name}
				</div>
				<div
					className="truncate"
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						fontFamily: "var(--font-mono)",
						marginTop: 1,
					}}
				>
					{agent.command}
					{agent.args?.length ? ` ${agent.args.join(" ")}` : ""}
				</div>
			</div>
			{installed && (
				<span
					className="flex-shrink-0 rounded"
					style={{
						fontSize: 9,
						fontWeight: 600,
						color: "var(--success, #4ade80)",
						letterSpacing: "0.05em",
						textTransform: "uppercase",
						padding: "2px 5px",
						border:
							"1px solid color-mix(in srgb, var(--success, #4ade80) 40%, transparent)",
					}}
				>
					Installed
				</span>
			)}
			{agent.builtin ? (
				<span
					className="flex-shrink-0 rounded"
					style={{
						fontSize: 9,
						fontWeight: 600,
						color: "var(--fg-secondary)",
						letterSpacing: "0.05em",
						textTransform: "uppercase",
						padding: "2px 5px",
						border: "1px solid var(--border)",
						opacity: 0.6,
					}}
				>
					Built-in
				</span>
			) : onRemove ? (
				<button
					type="button"
					onClick={onRemove}
					className="flex-shrink-0 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
					style={{
						width: 24,
						height: 24,
						color: "var(--fg-secondary)",
					}}
					onMouseEnter={(e) => {
						(e.currentTarget as HTMLElement).style.color = "var(--error)";
						(e.currentTarget as HTMLElement).style.backgroundColor =
							"color-mix(in srgb, var(--error) 10%, transparent)";
					}}
					onMouseLeave={(e) => {
						(e.currentTarget as HTMLElement).style.color =
							"var(--fg-secondary)";
						(e.currentTarget as HTMLElement).style.backgroundColor =
							"transparent";
					}}
				>
					<X size={13} />
				</button>
			) : null}
		</div>
	);
}

/* ─── Add agent form ─── */
function AddAgentForm({
	onAdd,
}: {
	onAdd: (name: string, command: string) => void;
}) {
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");

	const canSubmit = name.trim().length > 0 && command.trim().length > 0;

	const handleSubmit = () => {
		if (!canSubmit) return;
		onAdd(name.trim(), command.trim());
		setName("");
		setCommand("");
	};

	return (
		<div
			className="rounded-lg"
			style={{
				padding: "12px",
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
			}}
		>
			<div
				className="font-medium"
				style={{
					fontSize: 11,
					color: "var(--fg-secondary)",
					letterSpacing: "0.04em",
					marginBottom: 8,
				}}
			>
				Add Custom Agent
			</div>
			<div className="flex gap-2">
				<input
					type="text"
					placeholder="Name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
					className="flex-1 bg-transparent outline-none rounded-md"
					style={{
						color: "var(--fg-primary)",
						fontSize: 12,
						padding: "6px 8px",
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
						minWidth: 0,
					}}
				/>
				<input
					type="text"
					placeholder="Command"
					value={command}
					onChange={(e) => setCommand(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
					className="flex-1 bg-transparent outline-none rounded-md"
					style={{
						color: "var(--fg-primary)",
						fontSize: 12,
						padding: "6px 8px",
						border: "1px solid var(--border)",
						backgroundColor: "var(--bg-secondary)",
						fontFamily: "var(--font-mono)",
						minWidth: 0,
					}}
				/>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={!canSubmit}
					className="flex items-center gap-1.5 rounded-md transition-colors flex-shrink-0"
					style={{
						padding: "6px 10px",
						fontSize: 12,
						fontWeight: 500,
						color: canSubmit ? "var(--bg-primary)" : "var(--fg-secondary)",
						backgroundColor: canSubmit ? "var(--accent)" : "var(--bg-tertiary)",
						opacity: canSubmit ? 1 : 0.5,
						cursor: canSubmit ? "pointer" : "default",
					}}
				>
					<Plus size={12} />
					Add
				</button>
			</div>
		</div>
	);
}

/* ─── Bot icon for nav ─── */
function AgentIcon() {
	return (
		<svg
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 8V4H8" />
			<rect x="4" y="8" width="16" height="12" rx="2" />
			<path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
		</svg>
	);
}

/* ═══════════════════════════════════════════════
   Main SettingsPanel
   ═══════════════════════════════════════════════ */

/* ──��� Terminal icon for shell nav ─── */
function TerminalIcon() {
	return (
		<svg
			aria-hidden="true"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</svg>
	);
}

/* ─��─ Shell row ─── */
function ShellRow({
	name,
	path,
	isSelected,
	available,
	badge,
	onSelect,
}: {
	name: string;
	path: string;
	isSelected: boolean;
	available: boolean;
	badge?: string;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={available ? onSelect : undefined}
			className="w-full text-left rounded-lg flex items-center gap-3 transition-colors"
			style={{
				padding: "9px 10px",
				backgroundColor: isSelected
					? "color-mix(in srgb, var(--accent) 10%, transparent)"
					: "transparent",
				borderLeft: isSelected
					? "2px solid var(--accent)"
					: "2px solid transparent",
				opacity: available ? 1 : 0.4,
				cursor: available ? "pointer" : "default",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className="truncate flex items-center gap-2"
					style={{
						fontSize: 13,
						color: "var(--fg-primary)",
						lineHeight: 1.3,
					}}
				>
					{name}
					{badge && (
						<span
							className="flex-shrink-0 rounded"
							style={{
								fontSize: 9,
								fontWeight: 600,
								color: "var(--fg-secondary)",
								letterSpacing: "0.05em",
								textTransform: "uppercase",
								padding: "1px 5px",
								border: "1px solid var(--border)",
								opacity: 0.6,
							}}
						>
							{badge}
						</span>
					)}
				</div>
				{path && (
					<div
						className="truncate"
						style={{
							fontSize: 11,
							color: isSelected ? "var(--accent)" : "var(--fg-secondary)",
							fontFamily: "var(--font-mono)",
							marginTop: 1,
							opacity: isSelected ? 1 : 0.7,
						}}
					>
						{path}
					</div>
				)}
			</div>
			{isSelected && (
				<div style={{ color: "var(--accent)", flexShrink: 0 }}>
					<Check size={14} />
				</div>
			)}
			{!available && (
				<span
					className="flex-shrink-0"
					style={{
						fontSize: 10,
						color: "var(--fg-secondary)",
						opacity: 0.7,
					}}
				>
					Not found
				</span>
			)}
		</button>
	);
}

export function SettingsPanel({ open: isOpen, onClose }: Props) {
	const [section, setSection] = useState<Section>("theme");

	const currentTheme = useSettingsStore((s) => s.theme);
	const setTheme = useSettingsStore((s) => s.setTheme);
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
	const shellPath = useSettingsStore((s) => s.shellPath);
	const setShellPath = useSettingsStore((s) => s.setShellPath);
	const agents = useSettingsStore((s) => s.agents);
	const addAgent = useSettingsStore((s) => s.addAgent);
	const removeAgent = useSettingsStore((s) => s.removeAgent);
	const toggleAgent = useSettingsStore((s) => s.toggleAgent);
	const installedCommands = useAgentRegistryStore((s) => s.installedCommands);
	const agentHooksEnabled = useSettingsStore((s) => s.agentHooksEnabled);
	const setAgentHooksEnabled = useSettingsStore((s) => s.setAgentHooksEnabled);
	const gpuAccelerationEnabled = useSettingsStore(
		(s) => s.gpuAccelerationEnabled,
	);
	const setGpuAcceleration = useSettingsStore((s) => s.setGpuAcceleration);

	const darkThemes = useMemo(
		() => themeList().filter((t) => t.variant === "dark"),
		[],
	);
	const lightThemes = useMemo(
		() => themeList().filter((t) => t.variant === "light"),
		[],
	);

	const [systemFonts, setSystemFonts] = useState<FontEntry[]>([]);
	const systemFontsLoaded = useRef(false);
	useEffect(() => {
		if (!isOpen || systemFontsLoaded.current) return;
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
	}, [isOpen]);

	const [availableShells, setAvailableShells] = useState<AvailableShell[]>([]);
	const shellsLoaded = useRef(false);
	useEffect(() => {
		if (!isOpen || shellsLoaded.current) return;
		shellsIpc
			.listAvailable()
			.then((shells) => {
				setAvailableShells(shells);
				shellsLoaded.current = true;
			})
			.catch(() => {
				setAvailableShells([]);
			});
	}, [isOpen]);

	useEffect(() => {
		if (!isOpen) return;
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", handleEscape, true);
		return () => document.removeEventListener("keydown", handleEscape, true);
	}, [isOpen, onClose]);

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

	if (!isOpen) return null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss
		<div
			role="presentation"
			className="fixed inset-0 z-[200] flex items-center justify-center"
			style={{ backgroundColor: "rgba(0,0,0,0.55)" }}
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only, keyboard handled by parent */}
			<div
				role="dialog"
				className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
				style={{
					width: 840,
					height: 620,
					backgroundColor: "var(--bg-secondary)",
					border: "1px solid var(--border)",
					boxShadow:
						"0 25px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset",
				}}
				onClick={(e) => e.stopPropagation()}
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
					</div>

					{/* Right content */}
					<div className="flex-1 min-w-0 min-h-0 flex flex-col p-5 overflow-hidden">
						{section === "theme" && (
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
						)}

						{section === "terminal-font" && (
							<div className="flex flex-col gap-4 flex-1 min-h-0">
								<div className="flex-shrink-0">
									<SectionLabel>GPU Acceleration</SectionLabel>
									<div
										className="flex items-center gap-3 rounded-lg"
										style={{
											padding: "10px 12px",
											backgroundColor: "var(--bg-primary)",
											border: "1px solid var(--border)",
										}}
									>
										<Toggle
											checked={gpuAccelerationEnabled}
											onChange={setGpuAcceleration}
										/>
										<div className="flex-1 min-w-0">
											<div
												style={{
													fontSize: 13,
													color: "var(--fg-primary)",
													lineHeight: 1.3,
												}}
											>
												Render terminals on the GPU
											</div>
											<div
												style={{
													fontSize: 11,
													color: "var(--fg-secondary)",
													marginTop: 2,
													lineHeight: 1.4,
												}}
											>
												Smoother scrolling and faster paint on heavy output.
												When many panes are open at once, some fall back to CPU
												rendering automatically.
											</div>
										</div>
									</div>
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
									Choose the shell for new terminal panes. Existing panes are
									not affected.
								</p>
								<div className="overflow-y-auto flex flex-col flex-1 min-h-0 gap-0.5">
									<ShellRow
										name="System Default"
										path={availableShells.find((s) => s.isDefault)?.path ?? ""}
										isSelected={shellPath === null}
										available={true}
										badge="Default"
										onSelect={() => setShellPath(null)}
									/>
									{availableShells.map((shell) => (
										<ShellRow
											key={shell.path}
											name={shell.name}
											path={shell.path}
											isSelected={shellPath === shell.path}
											available={shell.available}
											onSelect={() => setShellPath(shell.path)}
										/>
									))}
								</div>
							</div>
						)}

						{section === "agents" && (
							<div className="flex flex-col gap-4 flex-1 min-h-0">
								<div className="flex-1 min-h-0 overflow-y-auto">
									<SectionLabel>Status Hooks</SectionLabel>
									<div
										className="flex items-center gap-3 rounded-lg"
										style={{
											padding: "10px 12px",
											marginBottom: 18,
											backgroundColor: "var(--bg-primary)",
											border: "1px solid var(--border)",
										}}
									>
										<Toggle
											checked={agentHooksEnabled}
											onChange={setAgentHooksEnabled}
										/>
										<div className="flex-1 min-w-0">
											<div
												style={{
													fontSize: 13,
													color: "var(--fg-primary)",
													lineHeight: 1.3,
												}}
											>
												Agent status hooks (beta)
											</div>
											<div
												style={{
													fontSize: 11,
													color: "var(--fg-secondary)",
													marginTop: 2,
													lineHeight: 1.4,
												}}
											>
												Registers hooks in Claude Code, Codex, Gemini, Qwen,
												Copilot and OpenCode so the status dot reflects real
												agent state — including a distinct dot when an agent is
												waiting for your input. Edits each agent's global
												config; turning this off removes those entries.
											</div>
										</div>
									</div>
									<SectionLabel>Coding Agents</SectionLabel>
									<p
										style={{
											fontSize: 12,
											color: "var(--fg-secondary)",
											marginBottom: 12,
											lineHeight: 1.5,
										}}
									>
										Agents are detected by terminal title matching. Enable or
										disable detection per agent, or add your own.
									</p>
									<div className="flex flex-col gap-0.5">
										{agents.map((agent) => (
											<AgentRow
												key={agent.id}
												agent={agent}
												installed={installedCommands.has(agent.command)}
												onToggle={() => toggleAgent(agent.id)}
												onRemove={
													agent.builtin
														? undefined
														: () => removeAgent(agent.id)
												}
											/>
										))}
									</div>
								</div>
								<div className="flex-shrink-0">
									<AddAgentForm onAdd={addAgent} />
								</div>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
