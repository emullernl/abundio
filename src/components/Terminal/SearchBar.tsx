import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
	searchAddon: SearchAddon;
	onClose: () => void;
}

export function SearchBar({ searchAddon, onClose }: Props) {
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (query) {
			searchAddon.findNext(query, { caseSensitive: false, regex: false });
		}
	}, [query, searchAddon]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Escape") {
				searchAddon.clearDecorations();
				onClose();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (e.shiftKey) {
					searchAddon.findPrevious(query, {
						caseSensitive: false,
						regex: false,
					});
				} else {
					searchAddon.findNext(query, { caseSensitive: false, regex: false });
				}
			}
		},
		[query, searchAddon, onClose],
	);

	return (
		<div
			className="absolute top-2 right-2 z-10 flex items-center gap-2 rounded-lg shadow-lg"
			style={{
				backgroundColor: "var(--bg-secondary)",
				border: "1px solid var(--border)",
				padding: "6px 10px",
			}}
		>
			<input
				ref={inputRef}
				type="text"
				placeholder="Search..."
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				className="bg-transparent outline-none"
				style={{ color: "var(--fg-primary)", fontSize: 13, width: 200 }}
			/>
			<button
				type="button"
				onClick={() =>
					searchAddon.findPrevious(query, {
						caseSensitive: false,
						regex: false,
					})
				}
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&#9650;
			</button>
			<button
				type="button"
				onClick={() =>
					searchAddon.findNext(query, { caseSensitive: false, regex: false })
				}
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&#9660;
			</button>
			<button
				type="button"
				onClick={() => {
					searchAddon.clearDecorations();
					onClose();
				}}
				className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)]"
				style={{ color: "var(--fg-secondary)", fontSize: 12 }}
			>
				&times;
			</button>
		</div>
	);
}
