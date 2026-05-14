import { Maximize2 } from "lucide-react";
import mermaid from "mermaid";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MermaidModal } from "./MermaidModal";

// The markdown preview always renders light ("printed paper" look), so Mermaid
// uses the light theme too.
mermaid.initialize({ startOnLoad: false, theme: "default" });

/** Walk a hast node collecting text — code children may be highlighted spans. */
// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
function getCodeText(node: any): string {
	if (!node) return "";
	if (node.type === "text") return node.value ?? "";
	if (Array.isArray(node.children))
		return node.children.map(getCodeText).join("");
	return "";
}

/** Renders one ```mermaid fenced block as an SVG diagram. */
function MermaidDiagram({ code }: { code: string }) {
	const [svg, setSvg] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const renderIdRef = useRef(0);

	useEffect(() => {
		if (!code.trim()) {
			setSvg("");
			setError(null);
			return;
		}
		let cancelled = false;
		const renderId = `mermaid-preview-${++renderIdRef.current}`;
		mermaid
			.render(renderId, code)
			.then(({ svg: rendered }) => {
				if (cancelled) return;
				setSvg(rendered);
				setError(null);
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(String(e));
			});
		return () => {
			cancelled = true;
		};
	}, [code]);

	if (error) {
		return (
			<pre
				style={{
					color: "var(--error)",
					background: "var(--bg-secondary)",
					padding: 8,
					fontSize: 12,
					borderRadius: 4,
					overflowX: "auto",
				}}
			>
				{code}
			</pre>
		);
	}

	if (!svg) {
		// Carry the source on the placeholder too, so printing can re-render the
		// diagram even before the on-screen render has finished.
		return (
			<div
				className="abundio-mermaid"
				data-mermaid-source={code}
				style={{
					height: 80,
					background: "var(--bg-secondary)",
					borderRadius: 4,
				}}
			/>
		);
	}

	return (
		<div className="abundio-mermaid" data-mermaid-source={code}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the expand button below is the keyboard-accessible control */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-expand convenience over the diagram */}
			<div
				className="abundio-mermaid-svg"
				onClick={() => setExpanded(true)}
				// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid sanitizes its own SVG output
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
			<button
				type="button"
				className="abundio-mermaid-expand"
				title="Expand diagram"
				aria-label="Expand diagram"
				onClick={() => setExpanded(true)}
			>
				<Maximize2 size={13} />
			</button>
			{expanded &&
				createPortal(
					<MermaidModal svg={svg} onClose={() => setExpanded(false)} />,
					document.body,
				)}
		</div>
	);
}

/**
 * `code` component override for <MarkdownPreview>. Intercepts ```mermaid fences
 * and renders them as diagrams; everything else falls through to the default
 * (syntax-highlighted) rendering.
 */
export function makeMarkdownCodeComponent() {
	return function MarkdownCode({
		className,
		children,
		node,
		...props
	}: {
		className?: string;
		children?: React.ReactNode;
		// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
		node?: any;
	}) {
		if (className && /\blanguage-mermaid\b/i.test(className)) {
			const code = getCodeText(node).replace(/\n$/, "");
			return <MermaidDiagram code={code} />;
		}
		return (
			<code className={className} {...props}>
				{children}
			</code>
		);
	};
}
