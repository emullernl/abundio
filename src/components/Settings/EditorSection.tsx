import { useSettingsStore } from "../../stores/settingsStore";
import { SectionLabel, ToggleRow } from "./primitives";

/**
 * Sibling of the Terminal page: configures the file pane.
 *
 * "Editor" is a UI label, not a domain term.
 * See GLOSSARY.md.
 */
export function EditorSection() {
	const editorWordWrap = useSettingsStore((s) => s.editorWordWrap);
	const toggleEditorWordWrap = useSettingsStore((s) => s.toggleEditorWordWrap);
	const markdownOpenRendered = useSettingsStore((s) => s.markdownOpenRendered);
	const toggleMarkdownOpenRendered = useSettingsStore(
		(s) => s.toggleMarkdownOpenRendered,
	);

	return (
		<div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
			<div className="flex-shrink-0">
				<SectionLabel>Editing</SectionLabel>
				<ToggleRow
					checked={editorWordWrap}
					onChange={toggleEditorWordWrap}
					label="Wrap long lines in the editor"
					description="Long lines fold onto the next row instead of scrolling sideways. Applies to open files and diffs alike, and can also be toggled from the editor itself."
				/>
			</div>
			<div className="flex-shrink-0">
				<SectionLabel>Markdown</SectionLabel>
				<ToggleRow
					checked={markdownOpenRendered}
					onChange={toggleMarkdownOpenRendered}
					label="Open markdown rendered"
					description="A markdown file opens as a formatted document, with a Source button to edit its text. When off, it opens as text. Each pane remembers the view you last picked."
				/>
				{/* The colour toggle deliberately stays on the preview's title bar —
				    its icon IS the state readout, which a settings row can't be
				    (ADR-0013). Point at it so its absence reads as intentional. */}
				<p
					style={{
						fontSize: 11,
						color: "var(--fg-secondary)",
						marginTop: 8,
						lineHeight: 1.5,
					}}
				>
					Rendered markdown follows your theme. Switch to printed-paper white
					from the pane's title bar.
				</p>
			</div>
		</div>
	);
}
