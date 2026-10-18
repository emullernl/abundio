import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { clearMatches, findRanges, paintMatches } from "../../lib/renderedFind";

interface Props {
	/** The rendered document to search. */
	target: HTMLElement | null;
	/** Changes whenever the rendered content does, so matches are re-found. */
	contentKey: string;
	onClose: () => void;
}

// The rendering is debounced (MarkdownRendered); re-find after it settles.
const REFIND_DELAY_MS = 300;

const buttonClass =
	"flex items-center justify-center rounded cursor-pointer border-0 bg-transparent " +
	"text-[var(--fg-secondary)] enabled:hover:bg-[var(--bg-tertiary)] enabled:hover:text-[var(--fg-primary)] " +
	"disabled:opacity-40 disabled:cursor-default";

/** Find over the rendered view of a Markdown window. */
export function MarkdownFindBar({ target, contentKey, onClose }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [ranges, setRanges] = useState<Range[]>([]);
	const [current, setCurrent] = useState(0);

	useEscapeKey(onClose);

	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
		return clearMatches;
	}, []);

	// `contentKey` is a trigger, not an input: the ranges are found in the DOM.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-find when the rendering changes
	useEffect(() => {
		const t = setTimeout(() => {
			const found = target ? findRanges(target, query) : [];
			setRanges(found);
			setCurrent((c) => (c < found.length ? c : 0));
		}, REFIND_DELAY_MS);
		return () => clearTimeout(t);
	}, [target, query, contentKey]);

	useEffect(() => {
		paintMatches(ranges, current);
	}, [ranges, current]);

	const step = (by: number) => {
		if (ranges.length === 0) return;
		setCurrent((c) => (c + by + ranges.length) % ranges.length);
	};

	const count =
		query === ""
			? ""
			: ranges.length === 0
				? "No results"
				: `${current + 1} of ${ranges.length}`;

	return (
		<div
			className="absolute flex items-center gap-1 z-10"
			style={{
				top: 8,
				right: 16,
				padding: "4px 4px 4px 8px",
				borderRadius: 6,
				background: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				boxShadow:
					"0 4px 14px color-mix(in srgb, var(--bg-primary) 60%, transparent)",
			}}
		>
			<input
				ref={inputRef}
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						step(e.shiftKey ? -1 : 1);
					}
				}}
				placeholder="Find"
				aria-label="Find in document"
				className="bg-transparent outline-none border-0 text-[var(--fg-primary)]"
				style={{ width: 180, fontSize: 12, padding: 0 }}
			/>
			<span
				aria-live="polite"
				style={{
					fontSize: 11,
					color: "var(--fg-secondary)",
					minWidth: 64,
					textAlign: "right",
					whiteSpace: "nowrap",
				}}
			>
				{count}
			</span>
			<button
				type="button"
				aria-label="Previous match"
				title="Previous match (Shift+Enter)"
				disabled={ranges.length === 0}
				onClick={() => step(-1)}
				className={buttonClass}
				style={{ width: 22, height: 22, padding: 0 }}
			>
				<ChevronUp size={14} />
			</button>
			<button
				type="button"
				aria-label="Next match"
				title="Next match (Enter)"
				disabled={ranges.length === 0}
				onClick={() => step(1)}
				className={buttonClass}
				style={{ width: 22, height: 22, padding: 0 }}
			>
				<ChevronDown size={14} />
			</button>
			<button
				type="button"
				aria-label="Close find"
				onClick={onClose}
				className={buttonClass}
				style={{ width: 22, height: 22, padding: 0 }}
			>
				<X size={14} />
			</button>
		</div>
	);
}
