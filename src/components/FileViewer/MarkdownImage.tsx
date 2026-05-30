import { useEffect, useState } from "react";
import { fs as fsApi } from "../../lib/ipc";
import { resolveMarkdownImageSrc } from "../../lib/resolveMarkdownImageSrc";

/**
 * `img` component override for <MarkdownPreview>.
 *
 * Remote images (`http(s):`, `data:`, `blob:`) render directly. Local images —
 * relative or absolute filesystem paths — can't be loaded by the webview from a
 * URL, so they're read off disk via `fs_read_file` (which returns base64 + mime
 * for images, the same path `ImageViewer` uses) and rendered as a `data:` URL.
 *
 * `baseDir` is the directory of the source markdown file; relative srcs resolve
 * against it.
 */
export function makeMarkdownImageComponent(baseDir: string) {
	return function MarkdownImage({
		src,
		alt,
		// `node` is the hast node react-markdown injects — not a DOM attribute.
		node: _node,
		...props
	}: {
		src?: string;
		alt?: string;
		// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
		node?: any;
	}) {
		const resolved = resolveMarkdownImageSrc(baseDir, src);
		const localPath = resolved?.kind === "local" ? resolved.path : null;

		const [dataUrl, setDataUrl] = useState<string | null>(null);
		const [failed, setFailed] = useState(false);

		useEffect(() => {
			if (!localPath) return;
			let cancelled = false;
			setDataUrl(null);
			setFailed(false);
			fsApi
				.readFile(localPath)
				.then((res) => {
					if (cancelled) return;
					if (res.fileType === "image" && res.content && res.mime) {
						setDataUrl(`data:${res.mime};base64,${res.content}`);
					} else {
						setFailed(true);
					}
				})
				.catch(() => {
					if (!cancelled) setFailed(true);
				});
			return () => {
				cancelled = true;
			};
		}, [localPath]);

		if (!resolved) return null;

		if (resolved.kind === "remote") {
			return <img src={resolved.url} alt={alt} {...props} />;
		}

		if (dataUrl) {
			return <img src={dataUrl} alt={alt} {...props} />;
		}

		if (failed) {
			return (
				<span
					title={resolved.path}
					style={{
						display: "inline-block",
						padding: "2px 6px",
						fontSize: "0.85em",
						color: "var(--error)",
						border: "1px dashed var(--error)",
						borderRadius: 4,
					}}
				>
					{alt ? `🖼 ${alt}` : "🖼 image not found"}
				</span>
			);
		}

		// Loading: render nothing rather than a broken-image icon.
		return null;
	};
}
