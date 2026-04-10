import { useEffect, useRef, useState } from "react";
import { useGitChangesStore } from "../../stores/gitChangesStore";
import { ChevronDown } from "../Icons";

interface Props {
	cwd: string;
	workspaceId: string;
}

export function BranchSelector({ cwd, workspaceId }: Props) {
	const baseBranch = useGitChangesStore((s) => s.baseBranch);
	const branchSelectorOpen = useGitChangesStore((s) => s.branchSelectorOpen);
	const toggleBranchSelector = useGitChangesStore(
		(s) => s.toggleBranchSelector,
	);
	const closeBranchSelector = useGitChangesStore((s) => s.closeBranchSelector);
	const availableBranches = useGitChangesStore((s) => s.availableBranches);
	const fetchBranches = useGitChangesStore((s) => s.fetchBranches);
	const setBaseBranch = useGitChangesStore((s) => s.setBaseBranch);

	const [filter, setFilter] = useState("");
	const [highlightIdx, setHighlightIdx] = useState(0);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (branchSelectorOpen) {
			fetchBranches(cwd);
			setFilter("");
			setHighlightIdx(0);
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [branchSelectorOpen, cwd, fetchBranches]);

	useEffect(() => {
		if (!branchSelectorOpen) return;
		function handleClickOutside(e: MouseEvent) {
			if (
				dropdownRef.current &&
				!dropdownRef.current.contains(e.target as Node)
			) {
				closeBranchSelector();
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [branchSelectorOpen, closeBranchSelector]);

	const filtered = [
		{ label: "Auto-detect", value: null as string | null },
		...availableBranches
			.filter((b) => !filter || b.toLowerCase().includes(filter.toLowerCase()))
			.map((b) => ({ label: b, value: b as string | null })),
	];

	function selectBranch(value: string | null) {
		setBaseBranch(workspaceId, value, cwd);
		closeBranchSelector();
	}

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlightIdx((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (filtered[highlightIdx]) selectBranch(filtered[highlightIdx].value);
		} else if (e.key === "Escape") {
			closeBranchSelector();
		}
	}

	return (
		<div className="relative" ref={dropdownRef}>
			<button
				type="button"
				onClick={toggleBranchSelector}
				className="flex items-center gap-1 rounded px-2 py-0.5 transition-colors"
				style={{
					backgroundColor: "var(--bg-tertiary)",
					color: "var(--accent)",
					fontSize: 11,
					height: 24,
					fontFamily: "var(--font-mono)",
					border: "1px solid transparent",
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.borderColor = "var(--border)";
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.borderColor = "transparent";
				}}
			>
				<span className="truncate" style={{ maxWidth: 120 }}>
					vs {baseBranch ?? "..."}
				</span>
				<ChevronDown size={10} />
			</button>

			{branchSelectorOpen && (
				<div
					className="absolute top-full left-0 mt-1 rounded-lg overflow-hidden shadow-lg"
					style={{
						backgroundColor: "var(--bg-secondary)",
						border: "1px solid var(--border)",
						width: 240,
						maxHeight: 280,
						zIndex: 50,
					}}
				>
					<div style={{ padding: 6, borderBottom: "1px solid var(--border)" }}>
						<input
							ref={inputRef}
							type="text"
							value={filter}
							onChange={(e) => {
								setFilter(e.target.value);
								setHighlightIdx(0);
							}}
							onKeyDown={handleKeyDown}
							placeholder="Filter branches..."
							className="w-full rounded px-2 py-1 outline-none"
							style={{
								backgroundColor: "var(--bg-primary)",
								color: "var(--fg-primary)",
								fontSize: 12,
								fontFamily: "var(--font-mono)",
								border: "1px solid var(--border)",
							}}
						/>
					</div>
					<div className="overflow-y-auto" style={{ maxHeight: 220 }}>
						{filtered.map((item, idx) => (
							<button
								key={item.value ?? "__auto__"}
								type="button"
								onClick={() => selectBranch(item.value)}
								className="w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors"
								style={{
									fontSize: 12,
									fontFamily: item.value
										? "var(--font-mono)"
										: "var(--font-ui)",
									color:
										item.value === null
											? "var(--fg-secondary)"
											: "var(--fg-primary)",
									fontStyle: item.value === null ? "italic" : "normal",
									backgroundColor:
										idx === highlightIdx ? "var(--bg-tertiary)" : "transparent",
									borderLeft:
										item.value === baseBranch
											? "2px solid var(--accent)"
											: "2px solid transparent",
								}}
								onMouseEnter={() => setHighlightIdx(idx)}
							>
								<span className="truncate">{item.label}</span>
								{item.value?.startsWith("origin/") && (
									<span style={{ color: "var(--fg-secondary)", fontSize: 10 }}>
										remote
									</span>
								)}
							</button>
						))}
						{filtered.length === 0 && (
							<div
								className="px-3 py-2"
								style={{ color: "var(--fg-secondary)", fontSize: 12 }}
							>
								No matching branches
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
