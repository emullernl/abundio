/* ─── Font size control ─── */
export function FontSizeControl({
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

export function ScrollbackControl({
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
