import type { SearchMatch } from "../../lib/types";

interface SearchResultMatchProps {
	match: SearchMatch;
	rootPath: string;
	onClick: () => void;
}

export function SearchResultMatch({ match, onClick }: SearchResultMatchProps) {
	const before = match.lineContent.slice(0, match.matchStart);
	const matched = match.lineContent.slice(match.matchStart, match.matchEnd);
	const after = match.lineContent.slice(match.matchEnd);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: search result item
		// biome-ignore lint/a11y/noStaticElementInteractions: clickable search result
		<div
			onClick={onClick}
			className="flex items-start gap-2 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
			style={{
				padding: "2px 8px 2px 28px",
				fontSize: 12,
				transitionDuration: "var(--transition-fast)",
			}}
		>
			<span
				className="flex-shrink-0"
				style={{
					color: "var(--fg-secondary)",
					minWidth: 32,
					textAlign: "right",
					userSelect: "none",
				}}
			>
				{match.lineNumber}
			</span>
			<span
				className="truncate min-w-0"
				style={{
					color: "var(--fg-primary)",
					fontFamily: "var(--font-mono)",
				}}
			>
				{before}
				<span
					style={{
						backgroundColor:
							"color-mix(in srgb, var(--accent) 25%, transparent)",
						borderRadius: 2,
					}}
				>
					{matched}
				</span>
				{after}
			</span>
		</div>
	);
}
