import type { CSSProperties, ReactNode } from "react";

/* ─── Section label ─── */
export function SectionLabel({ children }: { children: ReactNode }) {
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
export function SearchInput({
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

/* ─── Nav item in the left sidebar ─── */
export function NavItem({
	label,
	isActive,
	onClick,
	icon,
}: {
	label: string;
	isActive: boolean;
	onClick: () => void;
	icon: ReactNode;
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

/* ─── Toggle switch ─── */
export function Toggle({
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

/**
 * The bordered `Toggle + title + description` card.
 *
 * This markup was duplicated verbatim at five call sites across the settings
 * sections; every new toggle would have added another ~40 lines of it.
 */
export function ToggleRow({
	checked,
	onChange,
	label,
	description,
	style,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: ReactNode;
	description: ReactNode;
	/** Merged into the card's container — used where a call site needs spacing. */
	style?: CSSProperties;
}) {
	return (
		<div
			className="flex items-center gap-3 rounded-lg"
			style={{
				padding: "10px 12px",
				backgroundColor: "var(--bg-primary)",
				border: "1px solid var(--border)",
				...style,
			}}
		>
			<Toggle checked={checked} onChange={onChange} />
			<div className="flex-1 min-w-0">
				<div
					style={{
						fontSize: 13,
						color: "var(--fg-primary)",
						lineHeight: 1.3,
					}}
				>
					{label}
				</div>
				<div
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						marginTop: 2,
						lineHeight: 1.4,
					}}
				>
					{description}
				</div>
			</div>
		</div>
	);
}
