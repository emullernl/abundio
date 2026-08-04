import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../../lib/fuzzyMatch";
import type { FontEntry } from "../../lib/nerdFonts";
import { Check } from "../Icons";
import { SearchInput } from "./primitives";

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
export function FontPicker({
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
