import mermaid from "mermaid";

const PRINT_DIV_ID = "abundio-md-print";
const PRINT_STYLE_ID = "abundio-md-print-style";

/**
 * Print the rendered markdown inside a preview pane. `container` is the
 * preview pane's scroll container; the rendered document lives in its
 * `.wmde-markdown` child (produced by @uiw/react-markdown-preview).
 *
 * The preview always renders light, so the printed output — including Mermaid
 * diagrams — is light too; nothing about the on-screen state needs restoring.
 */
export async function printMarkdownPreview(container: Element): Promise<void> {
	const proseEl = container.querySelector<HTMLElement>(".wmde-markdown");
	if (!proseEl) return;

	// Remove any leftovers from a previous cancelled print
	document.getElementById(PRINT_DIV_ID)?.remove();
	document.getElementById(PRINT_STYLE_ID)?.remove();

	const style = document.createElement("style");
	style.id = PRINT_STYLE_ID;
	style.textContent = `
@page {
  size: auto;
  margin: 20mm 25mm;
}
@media print {
  html, body {
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: #fff !important;
  }
  body > *:not(#${PRINT_DIV_ID}) { display: none !important; }
  #${PRINT_DIV_ID} {
    display: block !important;
    position: static !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    font-family: system-ui, -apple-system, sans-serif;
    color: #000 !important;
    background: #fff !important;
    font-size: 15px;
    line-height: 1.7;
    margin: 0;
    padding: 0;
  }
  #${PRINT_DIV_ID} h1 { font-size: 2.25em; font-weight: 700; line-height: 1.2; margin-top: 0; margin-bottom: 0.5em; color: #000; }
  #${PRINT_DIV_ID} h2 { font-size: 1.75em; font-weight: 700; line-height: 1.2; margin-top: 1.6em; margin-bottom: 0.5em; color: #000; }
  #${PRINT_DIV_ID} h3 { font-size: 1.4em; font-weight: 600; margin-top: 1.4em; margin-bottom: 0.5em; color: #000; }
  #${PRINT_DIV_ID} h4 { font-size: 1.15em; font-weight: 600; margin-top: 1.2em; margin-bottom: 0.5em; color: #000; }
  #${PRINT_DIV_ID} h5 { font-size: 1em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1em; margin-bottom: 0.5em; color: #000; }
  #${PRINT_DIV_ID} h6 { font-size: 0.9em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 1em; margin-bottom: 0.5em; color: #555; }
  #${PRINT_DIV_ID} a { color: #2563eb; }
  #${PRINT_DIV_ID} code {
    background: #f3f4f6; border-radius: 3px;
    padding: 0.15em 0.4em; font-family: monospace; font-size: 0.875em;
  }
  #${PRINT_DIV_ID} pre {
    background: #f9fafb; border: 1px solid #e5e7eb;
    border-radius: 6px; padding: 1em; overflow-x: auto;
  }
  #${PRINT_DIV_ID} pre code { background: transparent; padding: 0; }
  #${PRINT_DIV_ID} blockquote {
    border-left: 3px solid #6366f1; padding-left: 1em;
    color: #4b5563; margin-left: 0;
  }
  #${PRINT_DIV_ID} table { border-collapse: collapse; width: 100%; }
  #${PRINT_DIV_ID} th, #${PRINT_DIV_ID} td {
    border: 1px solid #e5e7eb; padding: 0.5em 0.75em;
  }
  #${PRINT_DIV_ID} th { background: #f9fafb; font-weight: 600; }
  #${PRINT_DIV_ID} hr { border-color: #e5e7eb; }
  #${PRINT_DIV_ID} img, #${PRINT_DIV_ID} svg { max-width: 100%; }
  /* Strip interactive chrome from the printed page: the autolink-headings
     anchor icon, the code-block copy buttons, and any other buttons. */
  #${PRINT_DIV_ID} .anchor,
  #${PRINT_DIV_ID} .copied,
  #${PRINT_DIV_ID} button { display: none !important; }
}`;
	document.head.appendChild(style);

	const div = document.createElement("div");
	div.id = PRINT_DIV_ID;
	div.style.display = "none";
	div.innerHTML = proseEl.innerHTML;
	document.body.appendChild(div);

	// Re-render mermaid diagrams into the cloned print DOM. The preview's
	// on-screen Mermaid theme is already "default" (light), so no restore needed.
	const mermaidEls = Array.from(
		div.querySelectorAll<HTMLElement>(".abundio-mermaid[data-mermaid-source]"),
	);
	if (mermaidEls.length > 0) {
		await Promise.allSettled(
			mermaidEls.map(async (el, i) => {
				const source = el.getAttribute("data-mermaid-source");
				if (!source?.trim()) return;
				const { svg } = await mermaid.render(`mermaid-print-${i}`, source);
				el.innerHTML = svg;
			}),
		);
	}

	const cleanup = () => {
		document.getElementById(PRINT_DIV_ID)?.remove();
		document.getElementById(PRINT_STYLE_ID)?.remove();
	};
	window.addEventListener("afterprint", cleanup, { once: true });

	window.print();
}
