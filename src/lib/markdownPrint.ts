import mermaid from "mermaid";

const PRINT_DIV_ID = "abundio-md-print";
const PRINT_STYLE_ID = "abundio-md-print-style";

export async function printMarkdownProse(
	container: Element,
	liveTheme: "default" | "dark" = "default",
): Promise<void> {
	const proseEl = container.querySelector<HTMLElement>(".abundio-prose");
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
  #${PRINT_DIV_ID} h1, #${PRINT_DIV_ID} h2, #${PRINT_DIV_ID} h3,
  #${PRINT_DIV_ID} h4, #${PRINT_DIV_ID} h5, #${PRINT_DIV_ID} h6 {
    margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; color: #000;
  }
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
  #${PRINT_DIV_ID} img { max-width: 100%; }
}`;
	document.head.appendChild(style);

	const div = document.createElement("div");
	div.id = PRINT_DIV_ID;
	div.style.display = "none";
	div.innerHTML = proseEl.innerHTML;
	// Strip contenteditable so the browser doesn't show editing indicators
	for (const el of [
		div,
		...Array.from(div.querySelectorAll("[contenteditable]")),
	]) {
		(el as HTMLElement).removeAttribute("contenteditable");
	}
	document.body.appendChild(div);

	// Re-render mermaid diagrams with the default (light) theme for print
	const mermaidEls = Array.from(
		div.querySelectorAll<HTMLElement>(".mdx-mermaid[data-mermaid-source]"),
	);
	if (mermaidEls.length > 0) {
		mermaid.initialize({ startOnLoad: false, theme: "default" });
		await Promise.allSettled(
			mermaidEls.map(async (el, i) => {
				const source = el.getAttribute("data-mermaid-source");
				if (!source?.trim()) return;
				const { svg } = await mermaid.render(`mermaid-print-${i}`, source);
				el.innerHTML = svg;
			}),
		);
		// Restore the live theme so subsequent diagram renders in the editor are unaffected
		mermaid.initialize({ startOnLoad: false, theme: liveTheme });
	}

	const cleanup = () => {
		document.getElementById(PRINT_DIV_ID)?.remove();
		document.getElementById(PRINT_STYLE_ID)?.remove();
	};
	window.addEventListener("afterprint", cleanup, { once: true });

	window.print();
}
