interface ImageViewerProps {
	content: string; // base64 encoded
	mime: string;
	fileName: string;
}

export function ImageViewer({ content, mime, fileName }: ImageViewerProps) {
	return (
		<div
			className="flex flex-col items-center justify-center h-full w-full gap-4 p-8"
			style={{ backgroundColor: "var(--bg-primary)" }}
		>
			<img
				src={`data:${mime};base64,${content}`}
				alt={fileName}
				style={{
					maxWidth: "100%",
					maxHeight: "calc(100% - 40px)",
					objectFit: "contain",
					borderRadius: 4,
					border: "1px solid var(--border)",
				}}
			/>
			<span style={{ fontSize: 12, color: "var(--fg-secondary)" }}>
				{fileName}
			</span>
		</div>
	);
}
