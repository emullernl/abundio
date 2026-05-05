import { useEffect, useRef, useState } from "react";
import { ChevronRight, File, FolderOpen } from "../Icons";

interface EditingRowProps {
	depth: number;
	mode: "file" | "folder" | "rename";
	initialValue?: string;
	onCommit: (name: string) => void;
	onCancel: () => void;
}

export function EditingRow({
	depth,
	mode,
	initialValue = "",
	onCommit,
	onCancel,
}: EditingRowProps) {
	const [value, setValue] = useState(initialValue);
	const inputRef = useRef<HTMLInputElement>(null);
	const escapedRef = useRef(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only focus + selection
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		if (mode === "rename" && initialValue) {
			const dot = initialValue.lastIndexOf(".");
			input.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
		} else {
			input.select();
		}
	}, []);

	const commit = () => {
		if (!escapedRef.current) {
			onCommit(value);
		}
	};

	const Icon = mode === "folder" ? FolderOpen : File;
	const iconColor = mode === "folder" ? "var(--accent)" : "var(--fg-secondary)";

	return (
		<div
			className="w-full flex items-center gap-1"
			style={{
				paddingLeft: 8 + depth * 12,
				paddingRight: 8,
				height: 24,
				fontSize: 12,
			}}
		>
			{/* chevron slot */}
			<span style={{ width: 14, flexShrink: 0 }}>
				{mode === "folder" ? (
					<span style={{ color: "var(--fg-secondary)" }}>
						<ChevronRight size={12} />
					</span>
				) : null}
			</span>

			{/* icon slot */}
			<span style={{ color: iconColor, flexShrink: 0, display: "flex" }}>
				<Icon size={14} />
			</span>

			{/* inline input */}
			<input
				ref={inputRef}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						escapedRef.current = false;
						onCommit(value);
					} else if (e.key === "Escape") {
						e.preventDefault();
						escapedRef.current = true;
						onCancel();
					}
				}}
				onBlur={commit}
				className="flex-1 min-w-0"
				style={{
					background: "transparent",
					border: "1px solid var(--accent)",
					borderRadius: 2,
					outline: "none",
					fontSize: 12,
					color: "var(--fg-primary)",
					padding: "0 4px",
				}}
				spellCheck={false}
			/>
		</div>
	);
}
