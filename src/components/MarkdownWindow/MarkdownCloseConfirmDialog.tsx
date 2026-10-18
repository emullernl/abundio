import {
	describeFiles,
	dismissMarkdownSaveFailed,
	resolveMarkdownClose,
	saveFailedMessage,
	useMarkdownCloseConfirmStore,
} from "../../stores/markdownCloseConfirmStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { SaveConfirmDialog } from "../SaveConfirmDialog";

/** Mounted once per Profile window: Save / Don't Save / Cancel for unsaved
 *  edits in the Markdown windows this Window is about to close, and the
 *  notice when that Save fails. */
export function MarkdownCloseConfirmDialog() {
	const pending = useMarkdownCloseConfirmStore((s) => s.pending);
	const saveFailed = useMarkdownCloseConfirmStore((s) => s.saveFailed);
	if (saveFailed) {
		return (
			<ConfirmDialog
				title="Could not save"
				message={saveFailedMessage(saveFailed)}
				confirmLabel="OK"
				hideCancel
				onConfirm={dismissMarkdownSaveFailed}
				onCancel={dismissMarkdownSaveFailed}
			/>
		);
	}
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
