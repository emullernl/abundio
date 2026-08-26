import { DiffEditor, type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defineAbundioTheme, detectLanguage } from "../../lib/monacoShared";
import { setMonacoInstance } from "../../lib/themes";
import type { GitFileDiff } from "../../lib/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { ArrowLeft, File, GitCompare } from "../Icons";

interface Props {
	diff: GitFileDiff;
	onBack?: () => void;
	onOpenFile?: () => void;
	isActive?: boolean;
	language?: string | null;
}

export function DiffViewer({
	diff,
	onBack,
	onOpenFile,
	isActive = false,
	language: languageOverride,
}: Props) {
	const fontSize = useSettingsStore((s) => s.fontSize);
	const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
	const monacoFontSize = fontSize - 1;
	const editorWordWrap = useSettingsStore((s) => s.editorWordWrap);
	const [hideUnchanged, setHideUnchanged] = useState(true);
	const [sideBySide, setSideBySide] = useState(true);
	const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
	const isActiveRef = useRef(isActive);
	isActiveRef.current = isActive;

	const language = languageOverride ?? detectLanguage(diff.filePath);

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

			// A brand-new tab renders with isActive already true, before Monaco
			// has asynchronously loaded — the isActive-change effect below never
			// fires again for it, so focus explicitly here on first mount.
			if (isActiveRef.current) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => ed.focus());
				});
			}
		},
		[],
	);

	// Focus editor when this pane becomes active
	useEffect(() => {
		const de = diffEditorRef.current;
		if (isActive && de) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => de.focus());
			});
		}
	}, [isActive]);

	useEffect(() => {
		const de = diffEditorRef.current;
		if (!de) return;
		const ww = editorWordWrap ? "on" : "off";
		de.getOriginalEditor().updateOptions({ wordWrap: ww });
		de.getModifiedEditor().updateOptions({ wordWrap: ww });
	}, [editorWordWrap]);

	const fileName = diff.filePath.split("/").pop() ?? diff.filePath;
	const pathParts = diff.filePath.split("/");
	const directory = pathParts.slice(0, -1).join("/");
	const lineCounts = useMemo(
		() => ({
			new: diff.modified === "" ? 0 : diff.modified.split(/\r?\n/).length,
			old: diff.original === "" ? 0 : diff.original.split(/\r?\n/).length,
		}),
		[diff.modified, diff.original],
	);

	return (
		<div
			className="flex flex-col h-full"
			style={{
				background:
					"linear-gradient(145deg, color-mix(in srgb, var(--bg-secondary) 92%, var(--accent) 8%), var(--bg-primary) 55%)",
			}}
		>
			<div
				className="flex flex-col gap-2 px-4 py-3 flex-shrink-0"
				style={{
					borderBottom: "1px solid var(--border)",
					backgroundColor:
						"color-mix(in srgb, var(--bg-secondary) 86%, transparent)",
					boxShadow:
						"0 8px 24px color-mix(in srgb, var(--bg-primary) 45%, transparent)",
				}}
			>
				<div className="flex items-center gap-2 min-w-0">
					{onBack && (
						<button
							type="button"
							onClick={onBack}
							className="flex items-center justify-center rounded-lg w-7 h-7 transition-colors flex-shrink-0"
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
							<ArrowLeft size={15} />
						</button>
					)}
					<div className="flex items-center gap-2 min-w-0">
						<div
							className="flex items-center justify-center rounded-lg flex-shrink-0"
							style={{
								width: 30,
								height: 30,
								color: "var(--accent)",
								backgroundColor:
									"color-mix(in srgb, var(--accent) 14%, transparent)",
								border:
									"1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
							}}
						>
							<GitCompare size={15} />
						</div>
						<div className="min-w-0">
							<div className="flex items-center gap-1.5 min-w-0">
								<span
									style={{
										fontSize: 13,
										fontWeight: 650,
										color: "var(--fg-primary)",
									}}
								>
									{fileName}
								</span>
								<span
									className="truncate"
									title={diff.filePath}
									style={{
										fontSize: 11,
										color: "var(--fg-secondary)",
										fontFamily: "var(--font-mono)",
									}}
								>
									{directory ? `in ${directory}` : "root"}
								</span>
							</div>
							<div
								style={{
									fontSize: 10,
									color: "var(--fg-secondary)",
									marginTop: 2,
								}}
							>
								Review changes · read-only
							</div>
						</div>
					</div>
					<div className="flex-1" />
					{onOpenFile && (
						<button
							type="button"
							onClick={onOpenFile}
							title="Open editable file"
							className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors flex-shrink-0"
							style={{
								color: "var(--fg-secondary)",
								fontSize: 11,
								border: "1px solid var(--border)",
							}}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
								e.currentTarget.style.color = "var(--fg-primary)";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = "transparent";
								e.currentTarget.style.color = "var(--fg-secondary)";
							}}
						>
							<File size={13} />
							<span>Edit file</span>
						</button>
					)}
				</div>
				<div className="flex items-center gap-2 pl-9">
					<span
						style={{
							color: "var(--success)",
							fontSize: 11,
							fontFamily: "var(--font-mono)",
							fontWeight: 600,
						}}
					>
						{lineCounts.new} {lineCounts.new === 1 ? "line" : "lines"}
					</span>
					<span
						style={{
							color: "var(--error)",
							fontSize: 11,
							fontFamily: "var(--font-mono)",
							fontWeight: 600,
						}}
					>
						{lineCounts.old} {lineCounts.old === 1 ? "line" : "lines"}
					</span>
					<span
						style={{
							width: 1,
							height: 12,
							backgroundColor: "var(--border)",
							margin: "0 4px",
						}}
					/>
					<div className="flex-1" />
					<div
						className="flex items-center rounded-lg overflow-hidden"
						style={{ border: "1px solid var(--border)" }}
					>
						<button
							type="button"
							onClick={() => setSideBySide((v) => !v)}
							aria-pressed={sideBySide}
							className="px-2 py-1 transition-colors"
							style={{
								fontSize: 10,
								color: sideBySide ? "var(--accent)" : "var(--fg-secondary)",
								backgroundColor: sideBySide
									? "var(--bg-tertiary)"
									: "transparent",
							}}
							title="Toggle split and unified diff"
						>
							Split view
						</button>
						<button
							type="button"
							onClick={() => setHideUnchanged((v) => !v)}
							aria-pressed={hideUnchanged}
							title="Toggle unchanged lines"
							className="px-2 py-1 transition-colors"
							style={{
								fontSize: 10,
								color: hideUnchanged ? "var(--accent)" : "var(--fg-secondary)",
								backgroundColor: hideUnchanged
									? "var(--bg-tertiary)"
									: "transparent",
								borderLeft: "1px solid var(--border)",
							}}
						>
							Hide unchanged
						</button>
					</div>
				</div>
			</div>
			<div
				className="flex-1 min-h-0"
				// Transparent so the workspace ambient gradient shows through, matching
				// CodeEditor (Monaco's own background is transparent too — see defineAbundioTheme).
				style={{ backgroundColor: "transparent" }}
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
						renderSideBySide: sideBySide,
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
