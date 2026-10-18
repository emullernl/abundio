import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { writeClipboardText } from "../../lib/clipboard";
import { codeBlockCopyText } from "../../lib/codeBlockCopy";

const FEEDBACK_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

const LABELS: Record<CopyState, string> = {
	idle: "Copy code",
	copied: "Copied",
	failed: "Copy failed",
};

/**
 * `pre` component override for <MarkdownPreview>: the block plus a copy button
 * in its top-right corner. A ```mermaid block copies its source, since the
 * hast node still holds it after MermaidCode swaps the code for a diagram.
 */
export function MarkdownCodeBlock({
	children,
	node,
	...props
}: React.HTMLAttributes<HTMLPreElement> & {
	// biome-ignore lint/suspicious/noExplicitAny: hast node shape from react-markdown
	node?: any;
}) {
	const [state, setState] = useState<CopyState>("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const copy = async () => {
		let next: CopyState = "copied";
		try {
			await writeClipboardText(codeBlockCopyText(node));
		} catch {
			next = "failed";
		}
		setState(next);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
	};

	const Icon = state === "copied" ? Check : state === "failed" ? X : Copy;
	return (
		<pre {...props}>
			{children}
			<button
				type="button"
				className="abundio-code-copy"
				data-state={state}
				title={LABELS[state]}
				aria-label={LABELS[state]}
				onClick={copy}
			>
				<Icon size={13} />
			</button>
		</pre>
	);
}
