import {
	describeFiles,
	dismissFileWindowSaveFailed,
	resolveFileWindowClose,
	saveFailedMessage,
	useFileWindowCloseConfirmStore,
} from "../../stores/fileWindowCloseConfirmStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { SaveConfirmDialog } from "../SaveConfirmDialog";

/** Mounted once per Profile window: Save / Don't Save / Cancel for unsaved
 *  edits in the File windows this Window is about to close, and the
 *  notice when that Save fails. */
export function FileWindowCloseConfirmDialog() {
	const pending = useFileWindowCloseConfirmStore((s) => s.pending);
	const saveFailed = useFileWindowCloseConfirmStore((s) => s.saveFailed);
	if (saveFailed) {
		return (
			<ConfirmDialog
				title="Could not save"
				message={saveFailedMessage(saveFailed)}
				confirmLabel="OK"
				hideCancel
				onConfirm={dismissFileWindowSaveFailed}
				onCancel={dismissFileWindowSaveFailed}
			/>
		);
	}
	if (!pending) return null;
	return (
		<SaveConfirmDialog
			fileName={describeFiles(pending.fileNames)}
			onSave={() => void resolveFileWindowClose("save")}
			onDontSave={() => void resolveFileWindowClose("discard")}
			onCancel={() => void resolveFileWindowClose("cancel")}
		/>
	);
}
