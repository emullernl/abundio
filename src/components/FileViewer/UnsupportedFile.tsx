import { File } from "../Icons";

interface UnsupportedFileProps {
	fileName: string;
	size: number;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UnsupportedFile({ fileName, size }: UnsupportedFileProps) {
	return (
		<div
			className="flex flex-col items-center justify-center h-full w-full gap-3"
			style={{ backgroundColor: "var(--bg-primary)" }}
		>
			<span style={{ color: "var(--fg-secondary)" }}>
				<File size={48} />
			</span>
			<span style={{ fontSize: 14, color: "var(--fg-primary)", fontWeight: 500 }}>
				{fileName}
			</span>
			<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
				Binary or executable file ({formatSize(size)}) — cannot be displayed
			</span>
		</div>
	);
}
