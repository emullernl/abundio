import type { CodeBlockEditorProps } from "@mdxeditor/editor";
import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";

mermaid.initialize({ startOnLoad: false });

// Module-level signal so MarkdownEditor can trigger re-renders of all live
// MermaidBlock instances after calling mermaid.initialize() with a new theme.
const _themeListeners = new Set<() => void>();
export function notifyMermaidThemeChange() {
	for (const fn of _themeListeners) fn();
}

export function MermaidBlock({ code, nodeKey }: CodeBlockEditorProps) {
	const [svg, setSvg] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const renderIdRef = useRef(0);
	const [themeSeq, setThemeSeq] = useState(0);

	useEffect(() => {
		const bump = () => setThemeSeq((s) => s + 1);
		_themeListeners.add(bump);
		return () => {
			_themeListeners.delete(bump);
		};
	}, []);

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
	}, [code, nodeKey, themeSeq]);

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
			data-mermaid-source={code}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid SVG output is sanitized by mermaid itself
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
