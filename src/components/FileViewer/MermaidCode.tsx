import { Maximize2 } from "lucide-react";
import mermaid from "mermaid";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MermaidModal } from "./MermaidModal";

// Global theme stays light ("default"); a dark preview renders each diagram
// dark via a per-diagram init directive (see MermaidDiagram). Keeping the global
// light means the print re-render (markdownPrint.ts), which uses the original
// source, stays light without any theme juggling.
mermaid.initialize({ startOnLoad: false, theme: "default" });

// Mermaid derives the SVG's internal element IDs (arrowhead markers, gradients,
// clip-paths) from the id passed to `render`. A per-instance counter would reset
// to the same values across diagrams and across re-renders (e.g. toggling the
// preview colour mode remounts every diagram), so stale/duplicate IDs collide
// and `url(#…)` refs resolve to the wrong or removed defs — broken diagrams. A
// module-level, never-reused counter guarantees each render gets a unique id.
let mermaidRenderSeq = 0;

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
function MermaidDiagram({ code, dark }: { code: string; dark: boolean }) {
	const [svg, setSvg] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		if (!code.trim()) {
			setSvg("");
			setError(null);
			return;
		}
		let cancelled = false;
		const renderId = `mermaid-preview-${++mermaidRenderSeq}`;
		// Theme per-render via an init directive rather than `mermaid.initialize`,
		// so a dark on-screen diagram doesn't make the global theme dark — that
		// keeps print (which re-renders from the original `code`) light. See
		// ADR-0013.
		const renderSource = dark ? `%%{init: {'theme':'dark'}}%%\n${code}` : code;
		mermaid
			.render(renderId, renderSource)
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
	}, [code, dark]);

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
					<MermaidModal
						svg={svg}
						dark={dark}
						onClose={() => setExpanded(false)}
					/>,
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
export function makeMarkdownCodeComponent(dark: boolean) {
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
			return <MermaidDiagram code={code} dark={dark} />;
		}
		return (
			<code className={className} {...props}>
				{children}
			</code>
		);
	};
}
