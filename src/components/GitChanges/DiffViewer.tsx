import { DiffEditor, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { defineAbundioTheme, detectLanguage } from "../../lib/monacoShared";
import { setMonacoInstance } from "../../lib/themes";
import type { GitFileDiff } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { ArrowLeft } from "../Icons";

interface Props {
	diff: GitFileDiff;
	onBack: () => void;
}

export function DiffViewer({ diff, onBack }: Props) {
	const fontSize = useSettingsStore((s) => s.fontSize);
	const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
	const monacoFontSize = fontSize - 1;
	const editorWordWrap = useSettingsStore((s) => s.editorWordWrap);
	const [hideUnchanged, setHideUnchanged] = useState(true);
	const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);

	const language = detectLanguage(diff.filePath);

	const handleMount = useCallback(
		(ed: editor.IStandaloneDiffEditor, m: Monaco) => {
			diffEditorRef.current = ed;
			defineAbundioTheme(m);
			m.editor.setTheme("abundio");
			setMonacoInstance(m);
			const action = {
				id: "abundio.toggleWordWrap",
				label: "Toggle Word Wrap",
				contextMenuGroupId: "view",
				contextMenuOrder: 1.5,
				run: () => useSettingsStore.getState().toggleEditorWordWrap(),
			};
			ed.getOriginalEditor().addAction(action);
			ed.getModifiedEditor().addAction(action);
		},
		[],
	);

	useEffect(() => {
		const de = diffEditorRef.current;
		if (!de) return;
		const ww = editorWordWrap ? "on" : "off";
		de.getOriginalEditor().updateOptions({ wordWrap: ww });
		de.getModifiedEditor().updateOptions({ wordWrap: ww });
	}, [editorWordWrap]);

	const fileName = diff.filePath.split("/").pop() ?? diff.filePath;

	return (
		<div className="flex flex-col h-full">
			<div
				className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
				style={{
					borderBottom: "1px solid var(--border)",
					backgroundColor:
						"color-mix(in srgb, var(--bg-tertiary) 40%, transparent)",
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
					style={{
						fontSize: 12,
						color: "var(--fg-primary)",
						fontFamily: "var(--font-mono)",
					}}
					title={diff.filePath}
				>
					{fileName}
				</span>
				<div
					className="flex items-center rounded overflow-hidden"
					style={{ border: "1px solid var(--border)" }}
				>
					<button
						type="button"
						onClick={() => setHideUnchanged((v) => !v)}
						className="px-2 py-0.5 transition-colors"
						style={{
							fontSize: 10,
							color: hideUnchanged ? "var(--accent)" : "var(--fg-secondary)",
							backgroundColor: hideUnchanged
								? "var(--bg-tertiary)"
								: "transparent",
						}}
					>
						Hide unchanged
					</button>
				</div>
			</div>
			<div
				className="flex-1 min-h-0"
				style={{ backgroundColor: "var(--bg-primary)" }}
			>
				<DiffEditor
					height="100%"
					language={language}
					original={diff.original}
					modified={diff.modified}
					theme="abundio"
					onMount={handleMount}
					options={{
						fontFamily,
						fontSize: monacoFontSize,
						wordWrap: editorWordWrap ? "on" : "off",
						contextmenu: true,
						readOnly: true,
						minimap: { enabled: false },
						scrollBeyondLastLine: false,
						renderSideBySide: true,
						automaticLayout: true,
						lineNumbers: "on",
						overviewRulerLanes: 0,
						padding: { top: 8 },
						hideUnchangedRegions: {
							enabled: hideUnchanged,
						},
						scrollbar: {
							verticalScrollbarSize: 10,
							horizontalScrollbarSize: 10,
						},
					}}
				/>
			</div>
		</div>
	);
}
