import { useEffect, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { abundioTheme, getLanguageExtension, detectLanguage } from "../../lib/codemirrorShared";
import { useSettingsStore } from "../../stores/settingsStore";
import { ArrowLeft } from "../Icons";
import type { GitFileDiff } from "../../lib/types";

interface Props {
	diff: GitFileDiff;
	onBack: () => void;
}

const diffTheme = EditorView.theme({
	"&": {
		height: "100%",
	},
	".cm-scroller": {
		overflow: "auto",
	},
	".cm-changedLine": {
		backgroundColor: "color-mix(in srgb, var(--warning) 8%, transparent) !important",
	},
	".cm-changedText": {
		backgroundColor: "color-mix(in srgb, var(--warning) 20%, transparent) !important",
	},
	".cm-insertedLine": {
		backgroundColor: "color-mix(in srgb, var(--success) 8%, transparent) !important",
	},
	".cm-insertedText": {
		backgroundColor: "color-mix(in srgb, var(--success) 20%, transparent) !important",
	},
	".cm-deletedLine": {
		backgroundColor: "color-mix(in srgb, var(--error) 8%, transparent) !important",
	},
	".cm-deletedText": {
		backgroundColor: "color-mix(in srgb, var(--error) 20%, transparent) !important",
	},
	".cm-mergeViewGutter": {
		backgroundColor: "var(--bg-secondary)",
	},
});

export function DiffViewer({ diff, onBack }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<MergeView | null>(null);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const orientation = "a-b" as const;
	const [collapseUnchanged, setCollapseUnchanged] = useState(true);
	const [langExt, setLangExt] = useState<Extension[] | null>(null);

	const language = detectLanguage(diff.filePath);

	// Load language extension asynchronously
	useEffect(() => {
		let cancelled = false;
		setLangExt(null);
		getLanguageExtension(language).then((ext) => {
			if (!cancelled) setLangExt(ext);
		});
		return () => { cancelled = true; };
	}, [language]);

	// Build the MergeView once language is loaded (or resolved to empty)
	useEffect(() => {
		if (langExt === null || !containerRef.current) return;
		const container = containerRef.current;
		container.innerHTML = "";

		const baseExtensions = [
			lineNumbers(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			oneDark,
			abundioTheme,
			diffTheme,
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			...langExt,
		];

		const view = new MergeView({
			a: {
				doc: diff.original,
				extensions: [...baseExtensions],
			},
			b: {
				doc: diff.modified,
				extensions: [...baseExtensions],
			},
			parent: container,
			orientation,
			collapseUnchanged: collapseUnchanged ? { margin: 3, minSize: 4 } : undefined,
			highlightChanges: true,
			gutter: true,
		});
		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [diff.original, diff.modified, diff.filePath, langExt, orientation, collapseUnchanged]);

	const fileName = diff.filePath.split("/").pop() ?? diff.filePath;

	return (
		<div className="flex flex-col h-full">
			<div
				className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
				style={{
					borderBottom: "1px solid var(--border)",
					backgroundColor: "color-mix(in srgb, var(--bg-tertiary) 40%, transparent)",
				}}
			>
				<button
					type="button"
					onClick={onBack}
					className="flex items-center justify-center rounded w-6 h-6 transition-colors"
					style={{ color: "var(--fg-secondary)" }}
					onMouseEnter={(e) => {
						e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
						e.currentTarget.style.color = "var(--fg-primary)";
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.backgroundColor = "transparent";
						e.currentTarget.style.color = "var(--fg-secondary)";
					}}
				>
					<ArrowLeft size={14} />
				</button>
				<span
					className="truncate flex-1"
					style={{ fontSize: 12, color: "var(--fg-primary)", fontFamily: "var(--font-mono)" }}
					title={diff.filePath}
				>
					{fileName}
				</span>
				<div className="flex items-center rounded overflow-hidden" style={{ border: "1px solid var(--border)" }}>
					<button
						type="button"
						onClick={() => setCollapseUnchanged((v) => !v)}
						className="px-2 py-0.5 transition-colors"
						style={{
							fontSize: 10,
							color: collapseUnchanged ? "var(--accent)" : "var(--fg-secondary)",
							backgroundColor: collapseUnchanged ? "var(--bg-tertiary)" : "transparent",
						}}
					>
						Hide unchanged
					</button>
				</div>
			</div>
			<div
				ref={containerRef}
				className="flex-1 min-h-0"
				style={{
					backgroundColor: "var(--bg-primary)",
					overflow: "auto",
					"--cm-font-size": `${fontSize}px`,
					"--cm-font-family": fontFamily,
				} as React.CSSProperties}
			/>
		</div>
	);
}
