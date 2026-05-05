import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
	containerRef: React.RefObject<HTMLDivElement | null>;
	open: boolean;
	onClose: () => void;
}

function collectTextRanges(root: Element, query: string): Range[] {
	if (!query) return [];
	const ranges: Range[] = [];
	const lower = query.toLowerCase();
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			if (parent.closest('[role="toolbar"], script, style')) {
				return NodeFilter.FILTER_REJECT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		const text = node.textContent?.toLowerCase() ?? "";
		let idx = 0;
		while ((idx = text.indexOf(lower, idx)) !== -1) {
			const range = document.createRange();
			range.setStart(node, idx);
			range.setEnd(node, idx + query.length);
			ranges.push(range);
			idx += query.length;
		}
	}
	return ranges;
}

const supportsHighlights = typeof CSS !== "undefined" && "highlights" in CSS;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cssHighlights = supportsHighlights ? (CSS as any).highlights : null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HighlightCtor = supportsHighlights ? (window as any).Highlight : null;

function clearHighlights() {
	cssHighlights?.delete("md-find");
	cssHighlights?.delete("md-find-active");
}

function applyHighlights(ranges: Range[], idx: number) {
	if (!supportsHighlights || ranges.length === 0) {
		clearHighlights();
		return;
	}
	cssHighlights.set("md-find", new HighlightCtor(...ranges));
	if (ranges[idx]) {
		cssHighlights.set("md-find-active", new HighlightCtor(ranges[idx]));
		ranges[idx].startContainer.parentElement?.scrollIntoView({
			block: "nearest",
			behavior: "smooth",
		});
	}
}

export function MarkdownFindBar({ containerRef, open, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [activeIdx, setActiveIdx] = useState(0);
	const [matchCount, setMatchCount] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const rangesRef = useRef<Range[]>([]);
	const activeIdxRef = useRef(0);

	useEffect(() => {
		if (!open) {
			clearHighlights();
			setQuery("");
			setActiveIdx(0);
			setMatchCount(0);
			rangesRef.current = [];
			return;
		}
		inputRef.current?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const prose = containerRef.current?.querySelector(".abundio-prose");
		if (!prose) return;
		const ranges = collectTextRanges(prose, query);
		rangesRef.current = ranges;
		setMatchCount(ranges.length);
		activeIdxRef.current = 0;
		setActiveIdx(0);
		applyHighlights(ranges, 0);
	}, [query, open, containerRef]);

	const goNext = useCallback(() => {
		const ranges = rangesRef.current;
		if (!ranges.length) return;
		const next = (activeIdxRef.current + 1) % ranges.length;
		activeIdxRef.current = next;
		setActiveIdx(next);
		applyHighlights(ranges, next);
	}, []);

	const goPrev = useCallback(() => {
		const ranges = rangesRef.current;
		if (!ranges.length) return;
		const prev = (activeIdxRef.current - 1 + ranges.length) % ranges.length;
		activeIdxRef.current = prev;
		setActiveIdx(prev);
		applyHighlights(ranges, prev);
	}, []);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			} else if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) goPrev();
				else goNext();
			} else if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				e.stopPropagation();
				inputRef.current?.select();
			}
		},
		[onClose, goNext, goPrev],
	);

	if (!open) return null;

	const countLabel = !query
		? ""
		: matchCount === 0
			? "No results"
			: `${activeIdx + 1} / ${matchCount}`;

	return (
		<div
			className="mdx-find-bar absolute top-2 right-2 z-20 flex items-center gap-2 rounded-lg shadow-lg"
			style={{
				backgroundColor: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				padding: "6px 10px",
			}}
		>
			<input
				ref={inputRef}
				type="text"
				placeholder="Find..."
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				className="bg-transparent outline-none"
				style={{ color: "var(--fg-primary)", fontSize: 13, width: 180 }}
			/>
			<span
				style={{
					color: "var(--fg-secondary)",
					fontSize: 11,
					minWidth: 52,
					textAlign: "right",
					fontVariantNumeric: "tabular-nums",
				}}
			>
				{countLabel}
			</span>
			<button
				type="button"
				onClick={goPrev}
				title="Previous (Shift+Enter)"
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&#9650;
			</button>
			<button
				type="button"
				onClick={goNext}
				title="Next (Enter)"
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&#9660;
			</button>
			<button
				type="button"
				onClick={onClose}
				title="Close (Esc)"
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 14 }}
			>
				&times;
			</button>
		</div>
	);
}
