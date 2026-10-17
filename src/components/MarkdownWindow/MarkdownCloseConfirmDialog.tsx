import {
	describeFiles,
	resolveMarkdownClose,
	useMarkdownCloseConfirmStore,
} from "../../stores/markdownCloseConfirmStore";
import { SaveConfirmDialog } from "../SaveConfirmDialog";

/** Mounted once per Profile window: Save / Don't Save / Cancel for unsaved
 *  edits in the Markdown windows this Window is about to close. */
export function MarkdownCloseConfirmDialog() {
	const pending = useMarkdownCloseConfirmStore((s) => s.pending);
	if (!pending) return null;
	return (
		<SaveConfirmDialog
			fileName={describeFiles(pending.fileNames)}
			onSave={() => void resolveMarkdownClose("save")}
			onDontSave={() => void resolveMarkdownClose("discard")}
			onCancel={() => void resolveMarkdownClose("cancel")}
		/>
	);
}
