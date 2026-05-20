import type { GitChangedFile } from "../../lib/types";

interface Props {
	file: GitChangedFile;
	isSelected: boolean;
	onClick: () => void;
}

const STATUS_COLORS: Record<string, string> = {
	A: "var(--success)",
	M: "var(--warning)",
	D: "var(--error)",
	R: "var(--accent)",
	"?": "var(--fg-secondary)",
};

const STATUS_LABELS: Record<string, string> = {
	A: "A",
	M: "M",
	D: "D",
	R: "R",
	"?": "U",
};

function fileName(path: string): string {
	return path.split("/").pop() ?? path;
}

function dirPath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 1) return "";
	return parts.slice(0, -1).join("/");
}

export function GitChangesFileItem({ file, isSelected, onClick }: Props) {
	const color = STATUS_COLORS[file.status] ?? "var(--fg-secondary)";
	const label = STATUS_LABELS[file.status] ?? file.status;
	const dir = dirPath(file.path);

	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full flex items-center gap-2 py-1 text-left transition-colors group"
			style={{
				height: 28,
				// Inline padding instead of Tailwind px-3 to avoid specificity issues with the borderLeft style
				paddingLeft: 12,
				paddingRight: 12,
				backgroundColor: isSelected ? "var(--bg-tertiary)" : "transparent",
				borderLeft: isSelected
					? "2px solid var(--accent)"
					: "2px solid transparent",
			}}
			onMouseEnter={(e) => {
				if (!isSelected)
					e.currentTarget.style.backgroundColor =
						"color-mix(in srgb, var(--bg-tertiary) 60%, transparent)";
			}}
			onMouseLeave={(e) => {
				if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
			}}
		>
			<span
				className="flex-shrink-0 inline-flex items-center justify-center rounded font-bold"
				style={{
					width: 18,
					height: 18,
					fontSize: 10,
					color,
					backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
					fontFamily: "var(--font-ui)",
				}}
			>
				{label}
			</span>
			<span
				className="truncate flex-1 min-w-0"
				style={{
					fontSize: 12,
					color: "var(--fg-primary)",
					fontFamily: "var(--font-ui)",
				}}
			>
				{fileName(file.path)}
				{dir && (
					<span style={{ color: "var(--fg-secondary)", marginLeft: 4 }}>
						{dir}
					</span>
				)}
			</span>
			<span
				className="flex-shrink-0 flex items-center gap-1"
				style={{ fontSize: 11, fontFamily: "var(--font-ui)" }}
			>
				{file.additions > 0 && (
					<span style={{ color: "var(--success)" }}>+{file.additions}</span>
				)}
				{file.deletions > 0 && (
					<span style={{ color: "var(--error)" }}>-{file.deletions}</span>
				)}
			</span>
		</button>
	);
}
