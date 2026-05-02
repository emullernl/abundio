import type { CodeBlockEditorProps } from "@mdxeditor/editor";
import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";

mermaid.initialize({ startOnLoad: false });

export function MermaidBlock({ code, nodeKey }: CodeBlockEditorProps) {
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const renderIdRef = useRef(0);

	useEffect(() => {
		if (!code.trim()) {
			setSvg("");
			setError(null);
			return;
		}
		const renderId = `mermaid-${nodeKey}-${++renderIdRef.current}`;
		mermaid
			.render(renderId, code)
			.then(({ svg: rendered }) => {
				setSvg(rendered);
				setError(null);
			})
			.catch((e: unknown) => {
				setError(String(e));
			});
	}, [code, nodeKey]);

	if (error) {
		return (
			<pre
				style={{
					color: "var(--error)",
					background: "var(--bg-secondary)",
					padding: "8px",
					fontSize: "12px",
					borderRadius: "4px",
					overflowX: "auto",
				}}
			>
				{code}
			</pre>
		);
	}

	if (!svg) {
		return (
			<div
				style={{
					height: 80,
					background: "var(--bg-secondary)",
					borderRadius: 4,
				}}
			/>
		);
	}

	return (
		<div
			className="mdx-mermaid"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid SVG output is sanitized by mermaid itself
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
